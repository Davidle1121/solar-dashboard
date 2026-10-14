import handlers from '../lib/sigen-handlers.cjs';
export default function handler(req,res){return handlers.handleSync(req,res);}
