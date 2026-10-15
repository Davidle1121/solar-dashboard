const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const output=path.join(root,'public');
// Rebuild the generated output so removed integration assets cannot survive.
fs.rmSync(output,{recursive:true,force:true});
fs.mkdirSync(output,{recursive:true});
// Publish only browser assets. Server code, dependencies, credentials and collected
// energy records must never be copied into the static output directory.
for(const file of ['index.html','login.html'])fs.copyFileSync(path.join(root,file),path.join(output,file));
console.log('Static site output prepared');
