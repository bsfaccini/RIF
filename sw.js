// ╔══════════════════════════════════════════════════════════════════╗
// ║  RIF Service Worker v1.0.0                                       ║
// ║  — Cache offline completo                                        ║
// ║  — Verifica atualização: abertura + 17:30 diário                 ║
// ║  — Aplica automaticamente à meia-noite                           ║
// ║  — Push notifications nativas                                    ║
// ╚══════════════════════════════════════════════════════════════════╝

var SW_VERSION       = '1.0.0';
var CACHE_NAME       = 'rif-cache-v1';
var TG_BOT_TOKEN     = '8030143723:AAFLY4T3xa6XmRroAW582F432RUBg94z4pl';
var TG_CHAT_ID       = '-1003326401807';
var TG_UPDATE_THREAD = 423;

// Chaves de controle no cache (usadas como storage leve)
var KEY_PENDING_UPDATE = 'rif-pending-update';   // { versao, fileId, caption }
var KEY_LAST_CHECK     = 'rif-last-check';        // ISO timestamp

var CACHE_URLS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
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

// ── Helpers de storage leve via IDB/cache ─────────────────────────
// Usa um cartão especial no cache para guardar estado
var _store = {};

function _saveStore() {
  try {
    caches.open(CACHE_NAME).then(function(cache) {
      cache.put('/__rif_sw_store__', new Response(JSON.stringify(_store), {
        headers: { 'Content-Type': 'application/json' }
      }));
    });
  } catch(e) {}
}

async function _loadStore() {
  try {
    var cache = await caches.open(CACHE_NAME);
    var resp  = await cache.match('/__rif_sw_store__');
    if (resp) _store = await resp.json();
  } catch(e) {}
}

// ── Verificar atualização no Telegram ────────────────────────────
async function verificarAtualizacao() {
  try {
    var resp = await fetch(
      'https://api.telegram.org/bot' + TG_BOT_TOKEN
      + '/getUpdates?limit=30&allowed_updates=["message"]'
    );
    if (!resp.ok) return null;
    var data = await resp.json();
    if (!data.ok || !data.result) return null;

    // Filtrar mensagens com .html no tópico de atualizações
    var msgs = data.result.filter(function(u) {
      return u.message &&
             u.message.message_thread_id === TG_UPDATE_THREAD &&
             u.message.document &&
             u.message.document.file_name &&
             /index_v[\d.]+\.html/i.test(u.message.document.file_name);
    });

    if (!msgs.length) return null;

    // Pegar a mais recente
    msgs.sort(function(a, b) { return b.message.date - a.message.date; });
    var ultima  = msgs[0].message;
    var nomeArq = ultima.document.file_name;
    var match   = nomeArq.match(/index_v([\d.]+)\.html/i);
    if (!match) return null;

    return {
      versao:  match[1],
      fileId:  ultima.document.file_id,
      caption: ultima.caption || '',
      ts:      ultima.date
    };
  } catch(e) {
    console.warn('[SW] verificarAtualizacao:', e.message);
    return null;
  }
}

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

    // 1. Obter URL do arquivo no Telegram
    var infoResp = await fetch(
      'https://api.telegram.org/bot' + TG_BOT_TOKEN + '/getFile?file_id=' + fileId
    );
    var infoData = await infoResp.json();
    if (!infoData.ok) throw new Error('getFile falhou');

    var fileUrl = 'https://api.telegram.org/file/bot' + TG_BOT_TOKEN + '/' + infoData.result.file_path;

    // 2. Baixar o HTML novo
    var fileResp = await fetch(fileUrl);
    if (!fileResp.ok) throw new Error('Download falhou HTTP ' + fileResp.status);
    var novoHtml = await fileResp.text();
    if (novoHtml.length < 10000) throw new Error('Arquivo muito pequeno — pode estar corrompido');

    // 3. Substituir no cache
    var cache = await caches.open(CACHE_NAME);
    await cache.put('./index.html', new Response(novoHtml, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));

    // 4. Limpar update pendente
    delete _store[KEY_PENDING_UPDATE];
    _saveStore();

    console.log('[SW] Versão', versao, 'instalada com sucesso');

    // 5. Avisar todos os clientes abertos
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

// ── Notificar usuário sobre atualização disponível ────────────────
async function notificarAtualizacao(info) {
  try {
    await self.registration.showNotification('🔄 RIF — Nova versão v' + info.versao, {
      body:     info.caption || 'Toque para atualizar o app agora.',
      icon:     './icon-192.png',
      badge:    './icon-192.png',
      tag:      'rif-update',
      renotify: true,
      data:     { tipo: 'update', versao: info.versao, fileId: info.fileId },
      actions:  [
        { action: 'atualizar', title: '⬆ Atualizar agora' },
        { action: 'depois',    title: 'Depois'             }
      ]
    });
  } catch(e) {
    console.warn('[SW] notificarAtualizacao:', e.message);
  }
}

// ── Lógica principal de verificação com horários ──────────────────
async function rotinaDiariaVerificacao(versaoAtual, fonte) {
  console.log('[SW] Verificando atualização (' + fonte + ')...');
  var resultado = await verificarAtualizacao();
  if (!resultado) { console.log('[SW] Sem atualização disponível'); return; }
  if (!versaoMaior(resultado.versao, versaoAtual)) {
    console.log('[SW] Já na versão mais recente:', versaoAtual);
    return;
  }

  console.log('[SW] Nova versão encontrada:', resultado.versao, '| fonte:', fonte);

  // Salvar como pendente
  _store[KEY_PENDING_UPDATE] = resultado;
  _saveStore();

  if (fonte === 'meia-noite') {
    // Meia-noite: aplicar automaticamente
    var ok = await baixarEAplicar(resultado.fileId, resultado.versao);
    if (ok) {
      await self.registration.showNotification('✅ RIF atualizado para v' + resultado.versao, {
        body:  'O app foi atualizado automaticamente. Abra para usar a nova versão.',
        icon:  './icon-192.png',
        badge: './icon-192.png',
        tag:   'rif-update-auto',
        data:  { tipo: 'update-aplicado' }
      });
    }
  } else {
    // 17:30 ou abertura: perguntar ao usuário
    // Primeiro tentar avisar o app aberto
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
      // App não aberto: notificação push
      await notificarAtualizacao(resultado);
    }
  }
}

// ── Agendador de horários (verifica a cada minuto) ────────────────
var _ultimoMinutoChecado = -1;

function iniciarAgendador(versaoAtual) {
  // Verificar a cada 60 segundos se é horário especial
  setInterval(async function() {
    var agora   = new Date();
    var hora    = agora.getHours();
    var minuto  = agora.getMinutes();
    var minKey  = hora * 60 + minuto;

    if (minKey === _ultimoMinutoChecado) return;
    _ultimoMinutoChecado = minKey;

    // 17:30 — perguntar ao usuário
    if (hora === 17 && minuto === 30) {
      await rotinaDiariaVerificacao(versaoAtual, '17h30');
    }

    // 00:00 — aplicar automaticamente
    if (hora === 0 && minuto === 0) {
      await rotinaDiariaVerificacao(versaoAtual, 'meia-noite');
    }
  }, 60000); // verifica a cada 1 minuto
}

// ── Mensagens do app para o SW ────────────────────────────────────
self.addEventListener('message', async function(e) {
  if (!e.data) return;
  await _loadStore();

  // App abre → verificar atualização
  if (e.data.tipo === 'verificar-atualizacao') {
    var versaoAtual = e.data.versaoAtual || '1.0.0';
    iniciarAgendador(versaoAtual);
    await rotinaDiariaVerificacao(versaoAtual, 'abertura');
  }

  // App pede aplicação manual
  if (e.data.tipo === 'aplicar-atualizacao') {
    var ok = await baixarEAplicar(e.data.fileId, e.data.versao || '?');
    if (!ok && e.source) {
      e.source.postMessage({ tipo: 'atualizacao-erro', msg: 'Falha ao baixar' });
    }
  }

  // Navegar para OS (clique em notificação)
  if (e.data.tipo === 'navegar') {
    var clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) {
      clients[0].focus();
      clients[0].postMessage(e.data);
    }
  }
});

// ── Clique na notificação ─────────────────────────────────────────
self.addEventListener('notificationclick', async function(e) {
  e.notification.close();
  var dados  = e.notification.data || {};
  var action = e.action;

  if (dados.tipo === 'update' || dados.tipo === 'update-aplicado') {
    if (action === 'atualizar' || dados.tipo === 'update-aplicado') {
      // Aplicar atualização
      if (dados.fileId) {
        await baixarEAplicar(dados.fileId, dados.versao || '?');
      }
    }
    // Focar o app
    var clients = await self.clients.matchAll({ type: 'window' });
    if (clients.length > 0) { clients[0].focus(); return; }
    await self.clients.openWindow('./index.html');
    return;
  }

  // Notificação de OS → abrir direto no cartão
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

// ── Push externo ──────────────────────────────────────────────────
self.addEventListener('push', function(e) {
  if (!e.data) return;
  var payload;
  try { payload = e.data.json(); } catch(err) { payload = { title: 'RIF', body: e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(payload.title || 'RIF', {
      body:    payload.body || '',
      icon:    './icon-192.png',
      badge:   './icon-192.png',
      data:    payload.data || {},
      vibrate: [200, 100, 200],
      actions: (payload.data && payload.data.osId)
        ? [{ action: 'abrir', title: '📋 Abrir OS' }] : []
    })
  );
});

console.log('[SW] Carregado v' + SW_VERSION
  + ' | Verificação: abertura + 17h30 | Auto-update: meia-noite');
