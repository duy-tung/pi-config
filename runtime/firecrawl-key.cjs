// Được pi-web-access gọi nội bộ. Không chạy để in key vào chat/log.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
try {
  const home=os.homedir();
  const dir=process.platform==='darwin'?path.join(home,'Library','Application Support','firecrawl-cli'):
    process.platform==='win32'?path.join(home,'AppData','Roaming','firecrawl-cli'):path.join(home,'.config','firecrawl-cli');
  const key=process.env.FIRECRAWL_API_KEY || JSON.parse(fs.readFileSync(path.join(dir,'credentials.json'),'utf8')).apiKey;
  if(typeof key!=='string'||!key.startsWith('fc-'))throw new Error('missing');
  process.stdout.write(key);
}catch{process.stderr.write('Chưa có credential Firecrawl. Chạy firecrawl login --browser.\n');process.exitCode=1;}
