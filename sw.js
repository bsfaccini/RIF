// ╔══════════════════════════════════════════════════════════════════╗
// ║  RIF Service Worker v1.0.2                                       ║
// ║  — Cache offline completo                                        ║
// ║  — Verifica atualização: abertura + 17:30 diário                 ║
// ║  — Aplica automaticamente à meia-noite                           ║
// ║  — Busca arquivo pelo nome no histórico do chat                  ║
// ╚══════════════════════════════════════════════════════════════════╝

var SW_VERSION       = '1.0.2';
var CACHE_NAME       = 'rif-cache-v2';
var TG_BOT_TOKEN     = '8030143723:AAFLY4T3xa6XmRroAW582F432RUBg94z4pl';
var TG_CHAT_ID       = '-1003326401807';
var TG_UPDATE_THREAD = 423;

var CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
];

// ── Instalar ──────────────────────────────────────────────────────
self.addEventListener('install', function(e) {
  console.log('[SW] Instalando v' + SW_VERSION);
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(CACHE_URLS.map(function(url) {
        return new Request(url, { cache: 'reload' });
      })).catch(function(err) {
        console.warn('[SW] Cache parcial:', err.message);
      });
    }).then(function() { return self.skipWaiting(); })
  );
});

// ── Ativar ────────────────────────────────────────────────────────
self.addEventListener('activate', function(e) {
  console.log('[SW] Ativando v' + SW_VERSION);
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

// ── Fetch: servir do cache quando offline ─────────────────────────
self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  if (url.includes('api.telegram.org') ||
      url.includes('api.trello.com') ||
      url.includes('supabase.co') ||
      url.includes('fonts.googleapis.com')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).then(function(response) {
        if (response && response.status === 200 && response.type === 'basic') {
          var cloned = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(e.request, cloned);
          });
        }
        return response;
      }).catch(function() {
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// ── Verificar atualização via Telegram ────────────────────────────
// Usa getMessages do chat para buscar no histórico completo
// não depende de getUpdates que pode estar vazio
async function verificarAtualizacao() {
  try {
    // Estratégia 1: buscar arquivos via search no histórico do tópico
    // Usando getUpdates com offset -1 para pegar os mais recentes
    var urls = [
      'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/getUpdates?limit=100&offset=-1&allowed_updates=["message","channel_post"]',
      'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/getUpdates?limit=100&allowed_updates=["message"]',
    ];

    var todosUpdates = [];

    for (var i = 0; i < urls.length; i++) {
      try {
        var resp = await fetch(urls[i]);
        if (!resp.ok) continue;
        var data = await resp.json();
        if (data.ok && data.result) {
          todosUpdates = todosUpdates.concat(data.result);
        }
      } catch(e) {}
    }

    // Remover duplicatas por update_id
    var vistos = {};
    todosUpdates = todosUpdates.filter(function(u) {
      if (vistos[u.update_id]) return false;
      vistos[u.update_id] = true;
      return true;
    });

    // Filtrar mensagens com documento .html no tópico correto
    var docs = todosUpdates.filter(function(u) {
      var msg = u.message || u.channel_post;
      if (!msg) return false;
      if (!msg.document) return false;
      var fname = msg.document.file_name || '';
      if (!/index_v[\d.]+\.html/i.test(fname)) return false;
      // Aceitar do tópico 423 OU sem tópico (pode ter sido enviado no canal principal)
      var threadOk = !msg.message_thread_id || msg.message_thread_id === TG_UPDATE_THREAD;
      return threadOk;
    });

    // Se não encontrou por thread, buscar em qualquer mensagem com o arquivo
    if (!docs.length) {
      docs = todosUpdates.filter(function(u) {
        var msg = u.message || u.channel_post;
        if (!msg || !msg.document) return false;
        return /index_v[\d.]+\.html/i.test(msg.document.file_name || '');
      });
    }

    if (!docs.length) {
      console.log('[SW] Nenhum arquivo de atualização encontrado');
      return null;
    }

    // Pegar o mais recente
    docs.sort(function(a, b) {
      var ma = a.message || a.channel_post;
      var mb = b.message || b.channel_post;
      return (mb.date || 0) - (ma.date || 0);
    });

    var msgFinal = docs[0].message || docs[0].channel_post;
    var nomeArq  = msgFinal.document.file_name;
    var match    = nomeArq.match(/index_v([\d.]+)\.html/i);
    if (!match) return null;

    console.log('[SW] Arquivo encontrado:', nomeArq, '| thread:', msgFinal.message_thread_id);

    return {
      versao:  match[1],
      fileId:  msgFinal.document.file_id,
      caption: msgFinal.caption || nomeArq,
      ts:      msgFinal.date
    };
  } catch(e) {
    console.warn('[SW] verificarAtualizacao:', e.message);
    return null;
  }
}

// ── Comparar versões ──────────────────────────────────────────────
function versaoMaior(nova, atual) {
  var n = nova.split('.').map(Number);
  var a = atual.split('.').map(Number);
  for (var i = 0; i < 3; i++) {
    if ((n[i]||0) > (a[i]||0)) return true;
    if ((n[i]||0) < (a[i]||0)) return false;
  }
  return false;
}

// ── Baixar e aplicar atualização ──────────────────────────────────
async function baixarEAplicar(fileId, versao) {
  try {
    console.log('[SW] Baixando versão', versao);
    var infoResp = await fetch(
      'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/getFile?file_id=' + fileId
    );
    var infoData = await infoResp.json();
    if (!infoData.ok) throw new Error('getFile falhou: ' + JSON.stringify(infoData));

    var fileUrl  = 'https://api.telegram.org/file/bot' + TG_BOT_TOKEN + '/' + infoData.result.file_path;
    var fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error('Download falhou HTTP ' + fileResp.status);
    var novoHtml = await fileResp.text();
    if (novoHtml.length < 10000) throw new Error('Arquivo suspeito — muito pequeno: ' + novoHtml.length + ' bytes');

    var cache = await caches.open(CACHE_NAME);
    await cache.put('./index.html', new Response(novoHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));

    console.log('[SW] Versão', versao, 'instalada com sucesso');

    var clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(function(c) {
      c.postMessage({ tipo: 'atualizacao-aplicada', versao: versao });
    });
    return true;
  } catch(e) {
    console.error('[SW] baixarEAplicar:', e.message);
    return false;
  }
}

// ── Notificar usuário ─────────────────────────────────────────────
async function notificarAtualizacao(info) {
  try {
    await self.registration.showNotification('🔄 RIF — Nova versão v' + info.versao, {
      body:     info.caption || 'Toque para atualizar.',
      icon:     './icon-192.png',
      badge:    './icon-192.png',
      tag:      'rif-update',
      renotify: true,
      data:     { tipo: 'update', versao: info.versao, fileId: info.fileId },
      actions:  [
        { action: 'atualizar', title: '⬆ Atualizar agora' },
        { action: 'depois',    title: 'Depois' }
      ]
    });
  } catch(e) { console.warn('[SW] notificar:', e.message); }
}

// ── Rotina principal com horários ─────────────────────────────────
async function rotinaDiariaVerificacao(versaoAtual, fonte) {
  console.log('[SW] Verificando (' + fonte + ') versão atual:', versaoAtual);
  var resultado = await verificarAtualizacao();
  if (!resultado) { console.log('[SW] Sem novidade'); return; }
  if (!versaoMaior(resultado.versao, versaoAtual)) {
    console.log('[SW] Já atualizado. Disponível:', resultado.versao, '| Atual:', versaoAtual);
    return;
  }
  console.log('[SW] NOVA VERSÃO:', resultado.versao);

  if (fonte === 'meia-noite') {
    var ok = await baixarEAplicar(resultado.fileId, resultado.versao);
    if (ok) {
      await self.registration.showNotification('✅ RIF atualizado para v' + resultado.versao, {
        body: 'App atualizado automaticamente. Abra para usar a nova versão.',
        icon: './icon-192.png',
        tag:  'rif-update-auto',
        data: { tipo: 'update-aplicado' }
      });
    }
  } else {
    var clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) {
      clients.forEach(function(c) {
        c.postMessage({
          tipo:    'atualizacao-disponivel',
          versao:  resultado.versao,
          fileId:  resultado.fileId,
          caption: resultado.caption
        });
      });
    } else {
      await notificarAtualizacao(resultado);
    }
  }
}

// ── Agendador 17:30 e meia-noite ─────────────────────────────────
var _ultimoMin = -1;
function iniciarAgendador(versaoAtual) {
  setInterval(async function() {
    var agora  = new Date();
    var hora   = agora.getHours();
    var minuto = agora.getMinutes();
    var minKey = hora * 60 + minuto;
    if (minKey === _ultimoMin) return;
    _ultimoMin = minKey;
    if (hora === 17 && minuto === 30) await rotinaDiariaVerificacao(versaoAtual, '17h30');
    if (hora === 0  && minuto === 0)  await rotinaDiariaVerificacao(versaoAtual, 'meia-noite');
  }, 60000);
}

// ── Mensagens do app ──────────────────────────────────────────────
self.addEventListener('message', async function(e) {
  if (!e.data) return;

  if (e.data.tipo === 'verificar-atualizacao') {
    var versaoAtual = e.data.versaoAtual || '1.0.0';
    iniciarAgendador(versaoAtual);
    await rotinaDiariaVerificacao(versaoAtual, 'manual');
  }

  if (e.data.tipo === 'aplicar-atualizacao') {
    var ok = await baixarEAplicar(e.data.fileId, e.data.versao || '?');
    if (!ok && e.source) {
      e.source.postMessage({ tipo: 'atualizacao-erro', msg: 'Falha ao baixar' });
    }
  }
});

// ── Clique na notificação ─────────────────────────────────────────
self.addEventListener('notificationclick', async function(e) {
  e.notification.close();
  var dados  = e.notification.data || {};
  var action = e.action;

  if (dados.tipo === 'update') {
    if (action === 'atualizar') {
      await baixarEAplicar(dados.fileId, dados.versao || '?');
    }
    var clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) { clients[0].focus(); return; }
    await self.clients.openWindow('./index.html');
    return;
  }

  var url = './index.html';
  if (dados.osId) url += '#os=' + dados.osId;
  else if (dados.tab) url += '#tab=' + dados.tab;

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(function(clients) {
        for (var i = 0; i < clients.length; i++) {
          if (clients[i].url.includes('index.html')) {
            clients[i].focus();
            clients[i].postMessage({ tipo: 'navegar', osId: dados.osId, tab: dados.tab });
            return;
          }
        }
        return self.clients.openWindow(url);
      })
  );
});

// ── Push ──────────────────────────────────────────────────────────
self.addEventListener('push', function(e) {
  if (!e.data) return;
  var payload;
  try { payload = e.data.json(); } catch(err) { payload = { title: 'RIF', body: e.data.text() }; }
  e.waitUntil(
    self.registration.showNotification(payload.title || 'RIF', {
      body:    payload.body || '',
      icon:    './icon-192.png',
      data:    payload.data || {},
      vibrate: [200, 100, 200]
    })
  );
});

console.log('[SW] v' + SW_VERSION + ' | Verifica: abertura + 17h30 | Auto: meia-noite');
