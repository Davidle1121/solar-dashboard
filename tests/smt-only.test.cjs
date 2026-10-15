const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

test('deployment and browser contain no retired provider endpoints, login code, or schedules',()=>{
  const config=JSON.parse(fs.readFileSync('vercel.json','utf8'));
  assert.equal(config.crons,undefined);
  const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
  assert.equal(pkg.dependencies?.['@vercel/blob'],undefined);
  assert.doesNotMatch(JSON.stringify(pkg.scripts),/sigen|bootstrap/i);
  for(const folder of ['api','lib','scripts']){
    if(!fs.existsSync(folder))continue;
    for(const name of fs.readdirSync(folder)){
      assert.doesNotMatch(name,/sigen/i);
      if(/\.(?:js|cjs)$/.test(name))assert.doesNotMatch(fs.readFileSync(path.join(folder,name),'utf8'),/sigencloud|sigenergy|SIGEN_|\/auth\/oauth\/token/i);
    }
  }
  const html=fs.readFileSync('index.html','utf8');
  assert.doesNotMatch(html,/sigen|sigData|solar-energy|tab-solar|solar-sync|battery/i);
  assert.doesNotMatch(html,/chart-balance|Daily Grid Import \/ Export \/ Net/);
  assert.match(html,/Daily Grid Import/);
  assert.match(html,/Hourly Profile Table/);
});
