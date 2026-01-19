const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

// ========================================
// CONFIGURAÇÕES - ALTERE AQUI
// ========================================
const CONFIG = {
    // URL do seu webhook no cPanel
    WEBHOOK_URL: 'https://sistema.intergrass.com.br/whatsapp_captador/webhook-whatsapp.php',
    
    // Porta do servidor Express
    PORT: process.env.PORT || 3000,
    
    // Ativar/desativar logs detalhados
    DEBUG: true,
    
    // Tempo de retry em caso de erro (ms)
    RETRY_DELAY: 5000
};

// ========================================
// SERVIDOR EXPRESS (HEALTH CHECK)
// ========================================
const app = express();
app.use(express.json());

// Variáveis de status
let connectionStatus = {
    connected: false,
    lastConnection: null,
    totalMessagesCaptured: 0,
    lastMessageTime: null,
    qrCode: null
};

// Endpoint de health check (para o Cron Job)
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'online',
        whatsapp: connectionStatus.connected ? 'connected' : 'disconnected',
        uptime: process.uptime(),
        totalMessages: connectionStatus.totalMessagesCaptured,
        lastMessage: connectionStatus.lastMessageTime,
        timestamp: new Date().toISOString()
    });
});

// Endpoint para ver QR Code (útil no Render)
app.get('/qr', (req, res) => {
    if (connectionStatus.qrCode) {
        res.send(`
            <html>
                <head><title>QR Code WhatsApp</title></head>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f0f0;">
                    <div style="text-align:center;background:white;padding:30px;border-radius:10px;box-shadow:0 4px 6px rgba(0,0,0,0.1);">
                        <h2>📱 Escaneie o QR Code</h2>
                        <p>Abra o WhatsApp → Aparelhos conectados → Conectar um aparelho</p>
                        <img src="${connectionStatus.qrCode}" style="max-width:400px;margin:20px 0;"/>
                        <p style="color:#666;">Atualize a página se o QR Code expirar</p>
                    </div>
                </body>
            </html>
        `);
    } else {
        res.send(`
            <html>
                <head>
                    <title>WhatsApp Status</title>
                    <meta http-equiv="refresh" content="5">
                </head>
                <body style="display:flex;justify-content:center;align-items:center;height:100vh;background:#f0f0f0;">
                    <div style="text-align:center;background:white;padding:30px;border-radius:10px;">
                        <h2>${connectionStatus.connected ? '✅' : '⏳'} Status WhatsApp</h2>
                        <p>${connectionStatus.connected ? 'Conectado e funcionando!' : 'Aguardando conexão...'}</p>
                        <p style="color:#666;">Esta página atualiza automaticamente</p>
                    </div>
                </body>
            </html>
        `);
    }
});

// Endpoint de estatísticas
app.get('/stats', (req, res) => {
    res.json(connectionStatus);
});

// Inicia servidor Express
app.listen(CONFIG.PORT, () => {
    console.log(`✅ Servidor rodando na porta ${CONFIG.PORT}`);
    console.log(`🔗 Health check: http://localhost:${CONFIG.PORT}/health`);
    console.log(`📱 QR Code: http://localhost:${CONFIG.PORT}/qr`);
});

// ========================================
// LOGGER
// ========================================
const logger = pino({ 
    level: CONFIG.DEBUG ? 'debug' : 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

// ========================================
// FUNÇÃO: ENVIAR PARA WEBHOOK
// ========================================
async function sendToWebhook(data) {
    try {
        logger.info(`📤 Enviando dados para webhook: ${data.name || data.number}`);
        
        const response = await axios.post(CONFIG.WEBHOOK_URL, data, {
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'WhatsApp-Captador/1.0'
            },
            timeout: 10000 // 10 segundos
        });

        if (response.status === 200) {
            logger.info(`✅ Dados enviados com sucesso: ${data.name || data.number}`);
            return true;
        } else {
            logger.warn(`⚠️ Webhook retornou status ${response.status}`);
            return false;
        }
    } catch (error) {
        logger.error(`❌ Erro ao enviar para webhook: ${error.message}`);
        
        // Retry após delay
        logger.info(`🔄 Tentando reenviar em ${CONFIG.RETRY_DELAY/1000}s...`);
        setTimeout(() => sendToWebhook(data), CONFIG.RETRY_DELAY);
        
        return false;
    }
}

// ========================================
// FUNÇÃO: OBTER FOTO DE PERFIL
// ========================================
/*
async function getProfilePicture(sock, jid) {
    try {
        const profilePicUrl = await sock.profilePictureUrl(jid, 'image');
        return profilePicUrl;
    } catch (error) {
        logger.debug(`Sem foto de perfil para ${jid}`);
        return null;
    }
}
*/
// ========================================
// FUNÇÃO: CONECTAR AO WHATSAPP
// ========================================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }), // Silencia logs internos do Baileys
        browser: ['WhatsApp Captador', 'Chrome', '10.0'],
        defaultQueryTimeoutMs: undefined,
    });

    // ========================================
    // EVENTO: ATUALIZAÇÃO DE CONEXÃO
    // ========================================
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        // Armazena QR Code
        if (qr) {
            connectionStatus.qrCode = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
            logger.info('📱 QR Code gerado! Acesse /qr para visualizar');
        }

        if (connection === 'close') {
            connectionStatus.connected = false;
            
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            
            logger.warn(`⚠️ Conexão fechada. Reconectar: ${shouldReconnect}`);
            
            if (shouldReconnect) {
                logger.info('🔄 Reconectando em 5 segundos...');
                setTimeout(() => connectToWhatsApp(), 5000);
            } else {
                logger.error('❌ Deslogado do WhatsApp. Escaneie o QR Code novamente.');
            }
        } else if (connection === 'open') {
            connectionStatus.connected = true;
            connectionStatus.lastConnection = new Date().toISOString();
            connectionStatus.qrCode = null;
            
            logger.info('✅ Conectado ao WhatsApp com sucesso!');
            logger.info(`📱 Número: ${sock.user.id.split(':')[0]}`);
        }
    });

    // ========================================
    // EVENTO: SALVAR CREDENCIAIS
    // ========================================
    sock.ev.on('creds.update', saveCreds);

    // ========================================
    // EVENTO: NOVAS MENSAGENS (PRINCIPAL)
    // ========================================
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return; // Ignora mensagens antigas

        for (const msg of messages) {
            // Ignora mensagens enviadas por você
            if (msg.key.fromMe) continue;

            // Ignora mensagens de grupos (opcional - remova se quiser captar grupos)
            if (msg.key.remoteJid.includes('@g.us')) continue;

            // Ignora mensagens do próprio número (verificação extra)
            const myNumber = sock.user.id.split(':')[0]; // Seu número
            const contactJid = msg.key.remoteJid;
            const contactNumber = contactJid.split('@')[0];
            
            if (contactNumber === myNumber) {
                logger.debug(`⏭️ Ignorando mensagem do próprio número: ${myNumber}`);
                continue;
            }

            try {
                //const contactJid = msg.key.remoteJid; // Ex: 5511999999999@s.whatsapp.net
                //contactNumber = contactJid.split('@')[0]; // Remove @s.whatsapp.net
                
                // Formata o número (opcional - mantém apenas dígitos)
                //const cleanNumber = contactNumber.replace(/\D/g, ''); // Remove caracteres não numéricos - Apenas dígitos: 5511999999999
                
                // Extrai texto da mensagem
                let messageText = 
                    msg.message.conversation ||
                    msg.message.extendedTextMessage?.text ||
                    msg.message.imageMessage?.caption ||
                    msg.message.videoMessage?.caption ||
                    '[Mídia sem texto]';

                // Obtém nome do contato
                const contactName = msg.pushName || contactNumber;

                // Obtém foto de perfil
                //const profilePicUrl = await getProfilePicture(sock, contactJid);

                // Monta objeto de dados
                const contactData = {
                    name: contactName,
                    number: contactNumber,
                    firstMessage: messageText,
                };
                /*
                const contactData = {
                    name: contactName,
                    number: contactNumber,
                    photo: profilePicUrl,
                    firstMessage: messageText,
                    timestamp: msg.messageTimestamp,
                    messageId: msg.key.id,
                    capturedAt: new Date().toISOString()
                };
                */

                logger.info('📨 Nova mensagem capturada:');
                logger.info(`   Nome: ${contactName}`);
                logger.info(`   Número: ${contactNumber}`);
                logger.info(`   Mensagem: ${messageText.substring(0, 50)}...`);

                // Envia para webhook
                await sendToWebhook(contactData);

                // Atualiza estatísticas
                connectionStatus.totalMessagesCaptured++;
                connectionStatus.lastMessageTime = new Date().toISOString();

            } catch (error) {
                logger.error(`❌ Erro ao processar mensagem: ${error.message}`);
            }
        }
    });

    return sock;
}

// Adicione após os outros endpoints (depois de /stats)

// ========================================
// ENDPOINT: VISUALIZAR LOGS
// ========================================
const logHistory = []; // Array para armazenar logs em memória
const MAX_LOG_HISTORY = 500; // Máximo de logs mantidos

// Intercepta logs do pino
const originalInfo = logger.info.bind(logger);
const originalWarn = logger.warn.bind(logger);
const originalError = logger.error.bind(logger);

logger.info = function(...args) {
    addToLogHistory('INFO', args);
    return originalInfo(...args);
};

logger.warn = function(...args) {
    addToLogHistory('WARN', args);
    return originalWarn(...args);
};

logger.error = function(...args) {
    addToLogHistory('ERROR', args);
    return originalError(...args);
};

function addToLogHistory(level, args) {
    const logEntry = {
        timestamp: new Date().toISOString(),
        level: level,
        message: args.join(' ')
    };
    
    logHistory.push(logEntry);
    
    // Mantém apenas os últimos MAX_LOG_HISTORY logs
    if (logHistory.length > MAX_LOG_HISTORY) {
        logHistory.shift();
    }
}

// Endpoint para visualizar logs
app.get('/logs', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const level = req.query.level; // Filtro opcional: INFO, WARN, ERROR
    
    let filteredLogs = logHistory;
    
    if (level) {
        filteredLogs = logHistory.filter(log => log.level === level.toUpperCase());
    }
    
    const recentLogs = filteredLogs.slice(-limit);
    
    res.send(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>📊 Logs - WhatsApp Captador</title>
            <meta http-equiv="refresh" content="10">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                body { 
                    font-family: 'Courier New', monospace; 
                    background: #1e1e1e; 
                    color: #d4d4d4; 
                    padding: 20px; 
                }
                .header { 
                    background: #252526; 
                    padding: 20px; 
                    border-radius: 8px; 
                    margin-bottom: 20px; 
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                }
                .header h1 { color: #fff; font-size: 24px; }
                .filters { display: flex; gap: 10px; }
                .filters a { 
                    padding: 8px 15px; 
                    background: #0e639c; 
                    color: white; 
                    text-decoration: none; 
                    border-radius: 4px; 
                    font-size: 14px;
                }
                .filters a:hover { background: #1177bb; }
                .filters a.active { background: #16825d; }
                .log-container { 
                    background: #252526; 
                    padding: 20px; 
                    border-radius: 8px; 
                    max-height: 80vh; 
                    overflow-y: auto; 
                }
                .log-entry { 
                    padding: 8px 0; 
                    border-bottom: 1px solid #3e3e42; 
                    font-size: 13px;
                    line-height: 1.6;
                }
                .log-entry:last-child { border-bottom: none; }
                .timestamp { color: #858585; margin-right: 10px; }
                .level { 
                    display: inline-block; 
                    padding: 2px 8px; 
                    border-radius: 3px; 
                    font-weight: bold; 
                    margin-right: 10px;
                    font-size: 11px;
                }
                .level.INFO { background: #0e639c; color: white; }
                .level.WARN { background: #d19a66; color: #1e1e1e; }
                .level.ERROR { background: #e06c75; color: white; }
                .message { color: #d4d4d4; }
                .auto-refresh { 
                    color: #858585; 
                    font-size: 12px; 
                    margin-top: 10px;
                }
                .stats {
                    display: flex;
                    gap: 20px;
                    margin-bottom: 10px;
                    font-size: 14px;
                }
                .stat { color: #858585; }
                .stat strong { color: #fff; }
            </style>
        </head>
        <body>
            <div class="header">
                <div>
                    <h1>📊 Logs em Tempo Real</h1>
                    <div class="stats">
                        <span class="stat">Total: <strong>${logHistory.length}</strong></span>
                        <span class="stat">Exibindo: <strong>${recentLogs.length}</strong></span>
                    </div>
                </div>
                <div class="filters">
                    <a href="/logs?limit=50" ${!level && limit === 50 ? 'class="active"' : ''}>Últimos 50</a>
                    <a href="/logs?limit=100" ${!level && limit === 100 ? 'class="active"' : ''}>Últimos 100</a>
                    <a href="/logs?limit=500" ${!level && limit === 500 ? 'class="active"' : ''}>Últimos 500</a>
                    <a href="/logs?level=ERROR&limit=100" ${level === 'ERROR' ? 'class="active"' : ''}>Apenas Erros</a>
                    <a href="/logs?level=WARN&limit=100" ${level === 'WARN' ? 'class="active"' : ''}>Apenas Avisos</a>
                </div>
            </div>
            
            <div class="log-container">
                ${recentLogs.reverse().map(log => `
                    <div class="log-entry">
                        <span class="timestamp">${new Date(log.timestamp).toLocaleString('pt-BR')}</span>
                        <span class="level ${log.level}">${log.level}</span>
                        <span class="message">${escapeHtml(log.message)}</span>
                    </div>
                `).join('')}
            </div>
            
            <p class="auto-refresh">🔄 Página atualiza automaticamente a cada 10 segundos</p>
        </body>
        </html>
    `);
});

// Função auxiliar para escapar HTML
function escapeHtml(text) {
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

// Endpoint para logs em JSON (para consumo por API)
app.get('/logs/json', (req, res) => {
    const limit = parseInt(req.query.limit) || 100;
    const level = req.query.level;
    
    let filteredLogs = logHistory;
    
    if (level) {
        filteredLogs = logHistory.filter(log => log.level === level.toUpperCase());
    }
    
    res.json({
        total: logHistory.length,
        showing: Math.min(limit, filteredLogs.length),
        logs: filteredLogs.slice(-limit).reverse()
    });
});

// ========================================
// INICIALIZAÇÃO
// ========================================
logger.info('🚀 Iniciando WhatsApp Captador...');
logger.info(`📡 Webhook configurado: ${CONFIG.WEBHOOK_URL}`);

connectToWhatsApp().catch(err => {
    logger.error('❌ Erro fatal ao conectar:', err);
    process.exit(1);
});

// Tratamento de erros não capturados
process.on('unhandledRejection', (err) => {
    logger.error('❌ Erro não tratado:', err);
});

process.on('uncaughtException', (err) => {
    logger.error('❌ Exceção não capturada:', err);
    process.exit(1);
});