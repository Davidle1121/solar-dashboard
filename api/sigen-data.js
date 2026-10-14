import handlers from '../lib/sigen-handlers.cjs';
export default function handler(req,res){
  if(req.method==='POST')return handlers.handleManualSync(req,res);
  if(req.method==='GET')return handlers.handleRead(req,res);
  res.setHeader('Allow','GET, POST');return res.status(405).json({error:'Method not allowed'});
}
