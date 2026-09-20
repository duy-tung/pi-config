import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const server=path.join(root,'runtimes/current/node_modules/@modelcontextprotocol/server-filesystem/dist/index.js');
process.argv=[process.execPath,server,process.cwd()];
await import(pathToFileURL(server).href);
