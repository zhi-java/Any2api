use crate::config::DesktopConfig;
use serde_json::Value;

#[derive(Debug)]
pub struct AdminClient {
    // reserved for future pooling
}

impl AdminClient {
        fn base(cfg: &DesktopConfig) -> String {
        format!("http://{}:{}", cfg.host, cfg.port)
    }

    pub fn request(
        cfg: &DesktopConfig,
        method: &str,
        path: &str,
        body: Option<&Value>,
        api_key: Option<&str>,
    ) -> Result<Value, String> {
        let url = format!("{}{}", Self::base(cfg), path);
        let agent = ureq::AgentBuilder::new()
            .timeout_connect(std::time::Duration::from_secs(3))
            .timeout_read(std::time::Duration::from_secs(60))
            .build();

        let mut req = match method.to_uppercase().as_str() {
            "GET" => agent.get(&url),
            "POST" => agent.post(&url),
            "PUT" => agent.put(&url),
            "PATCH" => agent.request("PATCH", &url),
            "DELETE" => agent.delete(&url),
            other => return Err(format!("unsupported method: {other}")),
        };

        req = req.set("Content-Type", "application/json");
        if let Some(key) = api_key.filter(|k| !k.is_empty()) {
            req = req.set("Authorization", &format!("Bearer {key}"));
        }

        let response = if let Some(body) = body {
            req.send_json(body.clone())
        } else if method.eq_ignore_ascii_case("POST")
            || method.eq_ignore_ascii_case("PUT")
            || method.eq_ignore_ascii_case("PATCH")
        {
            req.send_json(serde_json::json!({}))
        } else {
            req.call()
        };

        match response {
            Ok(resp) => {
                let status = resp.status();
                let text = resp.into_string().unwrap_or_default();
                if text.trim().is_empty() {
                    return Ok(serde_json::json!({ "ok": true, "status": status }));
                }
                match serde_json::from_str::<Value>(&text) {
                    Ok(v) => Ok(v),
                    Err(_) => Ok(serde_json::json!({ "raw": text, "status": status })),
                }
            }
            Err(ureq::Error::Status(code, resp)) => {
                let text = resp.into_string().unwrap_or_default();
                let message = serde_json::from_str::<Value>(&text)
                    .ok()
                    .and_then(|v| {
                        v.get("error")
                            .and_then(|e| e.get("message"))
                            .and_then(|m| m.as_str())
                            .map(|s| s.to_string())
                            .or_else(|| {
                                v.get("message")
                                    .and_then(|m| m.as_str())
                                    .map(|s| s.to_string())
                            })
                    })
                    .unwrap_or_else(|| {
                        if text.is_empty() {
                            format!("HTTP {code}")
                        } else {
                            text
                        }
                    });
                Err(format!("{message}"))
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn login(cfg: &DesktopConfig, api_key: &str) -> Result<Value, String> {
        // If server has no API key, login is optional.
        let status = Self::request(cfg, "GET", "/admin/api/auth/status", None, None)?;
        let required = status
            .get("authRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        if !required {
            return Ok(serde_json::json!({
                "success": true,
                "authenticated": true,
                "authRequired": false,
            }));
        }
        Self::request(
            cfg,
            "POST",
            "/admin/api/auth/login",
            Some(&serde_json::json!({ "apiKey": api_key })),
            Some(api_key),
        )
    }

    pub fn add_credential(
        cfg: &DesktopConfig,
        channel: &str,
        payload: Value,
        api_key: Option<&str>,
    ) -> Result<Value, String> {
        Self::request(
            cfg,
            "POST",
            &format!("/admin/api/channels/{channel}/credentials"),
            Some(&payload),
            api_key,
        )
    }

    pub fn test_channel(
        cfg: &DesktopConfig,
        channel: &str,
        api_key: Option<&str>,
    ) -> Result<Value, String> {
        Self::request(
            cfg,
            "POST",
            &format!("/admin/api/channels/{channel}/test"),
            Some(&serde_json::json!({})),
            api_key,
        )
    }

    pub fn health(cfg: &DesktopConfig, api_key: Option<&str>) -> Result<Value, String> {
        // public-ish path still behind admin auth if API_KEY set
        Self::request(cfg, "GET", "/admin/api/health", None, api_key)
            .or_else(|_| Self::request(cfg, "GET", "/healthz", None, None))
    }
}
