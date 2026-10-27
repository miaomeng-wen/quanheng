'use strict';
// Only the user's message is an instruction source. Transaction memos, tool data
// and quoted/external text are never sent to an executor or promoted to prompts.
const patterns = [/忽略.{0,8}(确认|验证|规则|指令)/, /直接.{0,8}(转走|转钱|把钱转)/, /(不用|无需|跳过|绕过).{0,5}(验证|确认)/, /把.{0,6}密码.{0,5}(告诉|给|发)/, /(查|查看).{0,5}别人/, /ignore.{0,20}(instructions|confirmation)/i];
function screen(message) { return {blocked:patterns.some(p=>p.test(message)),reason:'禁止绕过授权、泄露密码或查询他人账户；外部文本与流水备注仅作为数据。'}; }
module.exports={screen};
