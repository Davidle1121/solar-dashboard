const {collectSigen}=require('../lib/sigen-collector.cjs');
// Seed once on deployment; ordinary page views never log in to Sigenergy.
// Missing storage/provider access must not prevent the existing SMT site deploying.
if(['BLOB_READ_WRITE_TOKEN','SIGEN_USERNAME','SIGEN_PASSWORD','SIGEN_REGION'].every(name=>process.env[name])) {
  collectSigen({bootstrap:true}).then(result=>console.log('SIGEN_SYNC '+JSON.stringify(result)))
    .catch(()=>console.log('SIGEN_SYNC {"status":"pending","reason":"check-storage-and-provider-access"}'));
}else console.log('SIGEN_SYNC {"status":"pending","reason":"storage-or-account-configuration-missing"}');
