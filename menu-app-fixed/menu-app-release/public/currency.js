window.CURRENCIES={EUR:['€',2],USD:['$',2],GBP:['£',2],INR:['₹',2],NPR:['Rs ',2],JPY:['¥',0],AUD:['A$',2],CAD:['C$',2],AED:['AED ',2]};
window.fmt=(n,c)=>{const [s,d]=window.CURRENCIES[c]||[(c||'')+' ',2];return s+Number(n||0).toFixed(d)};
window.currencyOptions=()=>Object.entries(window.CURRENCIES).map(([k,v])=>`<option value="${k}">${k} (${v[0].trim()})</option>`).join('');
