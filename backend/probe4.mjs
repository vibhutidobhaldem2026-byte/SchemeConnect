process.loadEnvFile('.env');
const ms = await import('./scraper/adapters/myScheme.js');
const t=Date.now();
const { candidates, error } = await ms.discover({ id:'myscheme', level:'central', maxLinks: 600 });
console.log('  DISCOVERED '+candidates.length+' in '+Math.round((Date.now()-t)/1000)+'s'+(error?' | '+error:''));
await ms.close();
