import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

export const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
  const temporary=file+`.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value,null,2)+'\n', {mode:0o600});
  fs.renameSync(temporary,file);
}
export function run(command,args,options={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});
    child.once('error',reject);
    child.once('exit',(code,signal)=>code===0?resolve():reject(new Error(`Lệnh thất bại (${code ?? signal}): ${path.basename(command)}`)));
  });
}
export function npmCli(node=process.execPath) {
  const bin=path.dirname(node);
  const candidates=[path.join(bin,'node_modules/npm/bin/npm-cli.js'),path.resolve(bin,'../lib/node_modules/npm/bin/npm-cli.js')];
  if(process.env.npm_execpath?.endsWith('npm-cli.js'))candidates.push(process.env.npm_execpath);
  const found=candidates.find(fs.existsSync);
  if(!found)throw new Error('Không tìm thấy npm đi cùng Node. Chạy lại bằng install.sh/install.ps1.');
  return found;
}
export async function download(url,dest,expectedHash) {
  const response=await fetch(url,{signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`Tải thất bại HTTP ${response.status}: ${url}`);
  const content=Buffer.from(await response.arrayBuffer());
  if(expectedHash && sha256(content)!==expectedHash)throw new Error(`SHA256 không khớp: ${url}`);
  fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,content);
  return sha256(content);
}
export function shellQuote(value) {return "'"+String(value).replaceAll("'","'\\''")+"'";}
export function assertSafePath(value) {
  if(/[\r\n\0]/.test(value))throw new Error('Đường dẫn không được chứa ký tự điều khiển.');
  if(process.platform==='win32' && /[%]/.test(value))throw new Error('Đường dẫn Windows chứa % chưa được hỗ trợ.');
  return path.resolve(value);
}
