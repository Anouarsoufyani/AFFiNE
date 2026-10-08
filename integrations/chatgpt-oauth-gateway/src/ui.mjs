export function page(nonce, csrf) {
  return String.raw`<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>AFFiNE Local OAuth Gateway</title>
<style nonce="${nonce}">body{font:16px system-ui;max-width:850px;margin:48px auto;padding:0 20px;background:#fafafa;color:#222}button,input,select,textarea{font:inherit;padding:9px;margin:5px 0}button{cursor:pointer}textarea{width:95%;height:100px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eee;padding:16px}section{margin:24px 0}small{display:block;color:#555}</style>
<h1>AFFiNE Local OAuth Gateway</h1>
<p>Prototype local indépendant pour AFFiNE v0.27.4. Les identifiants restent dans le Trousseau de ce Mac.</p>
<small>La connexion partage les informations de compte autorisées avec ce programme. Le catalogue et les requêtes IA sont envoyés directement à OpenAI. Le texte saisi consomme ton quota ChatGPT. Aucun contenu de requête ni token n’est journalisé par la passerelle.</small>
<section><button id="connect">Continue with ChatGPT</button> <button id="new-account">Ajouter un compte / workspace</button>
<select id="accounts" aria-label="Compte ChatGPT"></select><button id="select-account">Activer le compte</button>
<button id="logout">Déconnecter</button> <button id="forget">Déconnecter et oublier le compte</button><pre id="status">Chargement…</pre></section>
<details><summary>Tests techniques de la gateway (facultatif)</summary><section><button id="models">Récupérer mes modèles</button> <select id="model" aria-label="Modèle GPT"></select>
<textarea id="prompt" aria-label="Message">Réponds en une phrase : bonjour !</textarea>
<button id="chat">Envoyer avec streaming</button> <button id="tool">Tester add(19,23) — environ 2 requêtes</button> <button id="stop">Arrêter</button>
<pre id="output" aria-live="polite"></pre></section></details>
<section><h2>Modèles utilisés dans AFFiNE local</h2>
<p>Choisis les modèles dans les menus. Le panneau met à jour les profils BYOK de l’environnement de test isolé.</p>
<button id="sandbox-refresh">Actualiser les catalogues</button><br>
<label>Assistant ChatGPT <select id="sandbox-chat" aria-label="Modèle ChatGPT pour AFFiNE"></select></label><br>
<label>Indexation locale <select id="sandbox-embedding" aria-label="Modèle d’embeddings pour AFFiNE"></select></label><br>
<button id="sandbox-apply">Appliquer dans AFFiNE</button> <a id="sandbox-open" href="http://127.0.0.1:33080/" target="_blank" rel="noreferrer">Ouvrir AFFiNE local</a>
<small>Changer le modèle d’embeddings nécessite une reconstruction de l’index. Les pages restent locales pour cette étape ; les extraits utilisés dans les réponses sont envoyés à ChatGPT.</small>
<label>Ajouter un modèle local <select id="sandbox-install-model" aria-label="Modèle d’embeddings à installer"><option value="qwen3-embedding:0.6b">Qwen3 Embedding 0.6B — compact, multilingue</option><option value="bge-m3">BGE M3 — multilingue, 1024 dimensions</option></select></label>
<button id="sandbox-install">Télécharger dans Ollama isolé</button><pre id="sandbox-status" aria-live="polite">Chargement des modèles…</pre></section>
<p><a href="https://chatgpt.com/#settings" target="_blank" rel="noreferrer">Gérer l’accès et l’utilisation dans ChatGPT</a></p>
<script nonce="${nonce}">
const csrf=${JSON.stringify(csrf)};const byId=id=>document.getElementById(id);let controller;
async function api(path,body){const response=await fetch(path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Gateway-CSRF':csrf},body:body===undefined?undefined:JSON.stringify(body)});const result=await response.json();if(!response.ok)throw new Error(result.error?.code||'request_failed');return result}
async function status(){const value=await api('/api/status');byId('status').textContent=JSON.stringify(value,null,2);byId('accounts').replaceChildren(...value.accounts.map(account=>{const option=document.createElement('option');option.value=account.client_id;option.textContent=account.label+' — '+(account.connected?'connecté':'déconnecté');option.selected=account.client_id===value.active;return option}))}
function action(id,fn){byId(id).onclick=async()=>{byId(id).disabled=true;try{await fn()}catch(error){byId('output').textContent=error.message}finally{byId(id).disabled=false}}}
action('connect',async()=>{const value=await api('/auth/start',{});location.assign(value.authorization_url)});
action('new-account',async()=>{const value=await api('/auth/start',{new_account:true});location.assign(value.authorization_url)});
action('select-account',async()=>{await api('/api/account',{client_id:byId('accounts').value});await status()});
for(const id of ['logout','forget'])action(id,async()=>{controller?.abort();const result=await api('/auth/logout',{forget:id==='forget'});await status();byId('output').textContent=result.revocation_confirmed?'Identifiants supprimés.':'Identifiants locaux supprimés. Révocation distante non confirmée : déconnecte aussi l’application dans ChatGPT Settings.'});
action('models',async()=>{const result=await api('/v1/models');byId('model').replaceChildren(...result.data.map(model=>{const option=document.createElement('option');option.value=model.id;option.textContent=model.display_name;return option}))});
async function stream(path,body){if(!body.model)throw new Error('Sélectionne un modèle accessible.');controller?.abort();controller=new AbortController();byId('output').textContent='';const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json','X-Gateway-CSRF':csrf},body:JSON.stringify(body),signal:controller.signal});if(!response.ok){const value=await response.json();throw new Error(value.error?.code||'request_failed')}const reader=response.body.getReader();const decoder=new TextDecoder();let pending='';let terminal=false;try{while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});let index;while((index=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,index);pending=pending.slice(index+2);const data=frame.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;const event=JSON.parse(data.slice(6));if(event.type==='response.output_text.delta')byId('output').textContent+=event.delta;if(event.type==='gateway.demo.tool_executed')byId('output').textContent+='\nFonction exécutée : '+JSON.stringify(event.result)+'\n';if(event.type==='gateway.error')throw new Error(event.error.code);if(event.type===(path==='/api/demo/tool'?'gateway.demo.completed':'response.completed'))terminal=true}}if(!terminal)throw new Error('Flux interrompu avant confirmation.')}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}}
action('chat',()=>stream('/v1/responses',{model:byId('model').value,input:[{role:'user',content:byId('prompt').value}],stream:true}));
action('tool',()=>stream('/api/demo/tool',{model:byId('model').value}));byId('stop').onclick=()=>controller?.abort();
status().catch(error=>byId('status').textContent=error.message);
function choices(id,models,selected){byId(id).replaceChildren(...models.map(model=>{const option=document.createElement('option');option.value=model.id;option.textContent=model.display_name+(model.dimensions?' — '+model.dimensions+' dimensions':'');option.disabled=model.compatible===false;option.selected=model.id===selected;return option}))}
async function sandboxCatalog(){const value=await api('/api/sandbox/catalog');choices('sandbox-chat',value.chatModels,value.chatModel);choices('sandbox-embedding',value.embeddingModels,value.embeddingModel);byId('sandbox-open').href=value.affineUrl;byId('sandbox-status').textContent='Assistant : '+(value.chatModel||'non configuré')+'\nEmbeddings : '+(value.embeddingModel||'non configurés')+'\nIndexation IA : '+(value.indexingEnabled?'activée':'désactivée');return value}
action('sandbox-refresh',()=>sandboxCatalog().catch(error=>{byId('sandbox-status').textContent=error.message}));
action('sandbox-apply',async()=>{byId('sandbox-status').textContent='Validation et configuration…';try{const value=await api('/api/sandbox/apply',{chatModel:byId('sandbox-chat').value,embeddingModel:byId('sandbox-embedding').value});await sandboxCatalog();if(value.reindexRequired)byId('sandbox-status').textContent+='\nModèle d’indexation changé : AFFiNE reconstruira l’index lors de la préparation des sources.'}catch(error){byId('sandbox-status').textContent=error.message}});
action('sandbox-install',async()=>{byId('sandbox-status').textContent='Téléchargement du modèle local…';try{await api('/api/sandbox/install',{model:byId('sandbox-install-model').value});await sandboxCatalog()}catch(error){byId('sandbox-status').textContent=error.message}});
sandboxCatalog().catch(error=>byId('sandbox-status').textContent=error.message);
</script></html>`;
}
