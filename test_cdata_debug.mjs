import {parseXmlToolCallsDetailed} from './src/core/prompt-strategy.js';

const tools = [
  {type:'function',function:{name:'Bash',description:'Run shell',parameters:{type:'object',properties:{command:{type:'string'}},required:['command']}}},
];

function run(label, cdataBody) {
  const trigger = '<Function_L4Pi_Start/>';
  const text = trigger + '\n<function_calls>\n  <function_call>\n    <tool>shell_command</tool>\n    <args_json><![CDATA[' + cdataBody + ']]></args_json>\n  </function_call>\n</function_calls>';
  const result = parseXmlToolCallsDetailed(text, {triggerSignal:trigger, tools});
  console.log(label + ': failureType=' + result.failureType + ' calls=' + (result.toolCalls?.length || 0));
  if (result.errorDetails) console.log('  error:', result.errorDetails);
  if (result.toolCalls?.[0]) {
    const args = JSON.parse(result.toolCalls[0].function.arguments);
    console.log('  command:', args.command);
    console.log('  has tab?', args.command.includes('\t'));
  }
}

// Use String.raw to keep \t as literal backslash-t
const body1 = String.raw`{"command":"Get-ChildItem -Force | Select-Object Name"}`;
const body2 = String.raw`{"command":"Get-ChildItem -Force -Path \"D:\tools\ting13\""}`;

run('scenario1 (plain cmd)', body1);
run('scenario2 (Win path)', body2);
