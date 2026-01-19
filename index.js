const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const express = require('express');
const axios = require('axios');
const pino = require('pino');

// ========================================
// CONFIGURAÇÕES - ALTERE AQUI
// ========================================
const CONFIG = {
    // URL do seu webhook no cPanel (você vai criar na Etapa 3)
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

            // Ignora se não tiver conteúdo
            if (!msg.message) continue;

            try {
                const contactJid = msg.key.remoteJid;
                const contactNumber = contactJid.split('@')[0];

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