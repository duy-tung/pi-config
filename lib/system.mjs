import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {sha256, writeAtomic} from '../runtime/merge.mjs';

export {sha256};
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function writeJson(file, value) {
  writeAtomic(file, JSON.stringify(value,null,2)+'\n', 0o600);
}
// Giới hạn thời gian mặc định của một lệnh con.
export const COMMAND_TIMEOUT_MS=600000;
// npm ci tải toàn bộ lockfile: trên runner Windows chậm, mỗi tarball từng mất 5-9 phút và cả lệnh vượt 10 phút.
const NPM_TIMEOUT_MINUTES=30;
/** Giới hạn của npm ci theo PI_CONFIG_NPM_TIMEOUT_MINUTES (phút, số dương); thiếu hoặc sai thì 30 phút. */
export function npmTimeout(env=process.env) {
  const minutes=Number(env.PI_CONFIG_NPM_TIMEOUT_MINUTES);
  return Math.round((Number.isFinite(minutes)&&minutes>0?minutes:NPM_TIMEOUT_MINUTES)*60000);
}
/**
 * Chạy lệnh con; quá timeout thì dừng và báo rõ là quá giờ, kèm timeoutHint nếu có. Tự hẹn giờ thay cho tùy chọn
 * timeout của spawn: npm bắt SIGTERM rồi thoát với mã 1, nên mã thoát không cho biết lệnh bị dừng vì quá giờ.
 */
export function run(command,args,{timeoutHint,timeout=COMMAND_TIMEOUT_MS,...options}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{stdio:'inherit',windowsHide:true,...options});
    let timedOut=false;
    const timer=timeout>0?setTimeout(()=>{timedOut=true;child.kill();},timeout):undefined;
    child.once('error',error=>{clearTimeout(timer);reject(error);});
    child.once('exit',(code,signal)=>{
      clearTimeout(timer);
      if(code===0&&!timedOut)return resolve();
      const name=path.basename(command);
      if(timedOut){
        const limit=timeout>=60000?`${Math.round(timeout/60000)} phút`:`${Math.round(timeout/1000)} giây`;
        return reject(new Error(`Lệnh chạy quá ${limit} nên bị dừng: ${name}${timeoutHint?`. ${timeoutHint}`:''}`));
      }
      reject(new Error(`Lệnh thất bại (${code ?? signal}): ${name}`));
    });
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
// Lệnh trong launcher và credential command của pi-web-access chạy dưới /bin/sh hoặc cmd.exe: dấu nháy là code,
// không phải escape của chuỗi JSON. Từ chối ký tự mở rộng của cmd vì không biểu diễn an toàn trong tham số có nháy.
export function shellQuote(value, platform = process.platform) {
  if (/[\0\r\n]/u.test(value)) throw new Error('Đường dẫn không được chứa NUL hoặc xuống dòng.');
  if (platform === 'win32') {
    if (/["%!]/u.test(value)) throw new Error('Đường dẫn Windows dùng cho credential helper không được chứa dấu nháy kép, % hoặc !.');
    return `"${value}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
export function assertSafePath(value) {
  if(/[\r\n\0]/.test(value))throw new Error('Đường dẫn không được chứa ký tự điều khiển.');
  if(process.platform==='win32' && /[%]/.test(value))throw new Error('Đường dẫn Windows chứa % chưa được hỗ trợ.');
  return path.resolve(value);
}
