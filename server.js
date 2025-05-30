const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const morgan = require('morgan');
const winston = require('winston');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Configuration Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.simple()
    })
  ]
});

// Middleware de sécurité
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"]
    }
  }
}));

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS 
  ? process.env.ALLOWED_ORIGINS.split(',')
  : ['http://localhost:3000', 'https://dev-solarmakers.odoo.com'];

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  optionsSuccessStatus: 200
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // max 100 requests per windowMs
  message: {
    error: 'Trop de requêtes, veuillez réessayer plus tard',
    retryAfter: '15 minutes'
  }
});

app.use(limiter);
app.use(morgan('combined'));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Variables MVola
const MVOLA_BASE_URL = process.env.NODE_ENV === 'production' 
  ? 'https://api.mvola.mg' 
  : 'https://devapi.mvola.mg';

// Cache pour le token
let tokenCache = {
  token: null,
  expires: null
};

// Fonction d'authentification MVola
async function authenticateMVola() {
  try {
    if (tokenCache.token && tokenCache.expires && Date.now() < tokenCache.expires) {
      return tokenCache.token;
    }

    const credentials = Buffer.from(
      `${process.env.MVOLA_CONSUMER_KEY}:${process.env.MVOLA_CONSUMER_SECRET}`
    ).toString('base64');

    const response = await axios.post(`${MVOLA_BASE_URL}/token`, 
      'grant_type=client_credentials&scope=EXT_INT_MVOLA_SCOPE',
      {
        headers: {
          'Authorization': `Basic ${credentials}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Cache-Control': 'no-cache'
        }
      }
    );

    const token = response.data.access_token;
    tokenCache = {
      token: token,
      expires: Date.now() + (response.data.expires_in * 1000) - 60000 // -1min de sécurité
    };

    logger.info('MVola authentication successful');
    return token;
  } catch (error) {
    logger.error('MVola authentication failed', { error: error.message });
    throw new Error('Échec de l\'authentification MVola');
  }
}

// ROUTES

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development'
  });
});

// Test auth MVola
app.post('/mvola/auth', async (req, res) => {
  try {
    const token = await authenticateMVola();
    res.json({
      success: true,
      message: 'Authentification MVola réussie',
      hasToken: !!token
    });
  } catch (error) {
    logger.error('Auth test failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Erreur d\'authentification',
      error: error.message
    });
  }
});

// Initier transaction
app.post('/mvola/transaction/initiate', async (req, res) => {
  try {
    const { amount, customerMSISDN, descriptionText, correlationId } = req.body;

    // Validation
    if (!amount || amount < 100) {
      return res.status(400).json({
        success: false,
        message: 'Montant invalide (minimum 100 Ar)'
      });
    }

    if (!customerMSISDN || !/^(032|033|034|037|038)\d{7}$/.test(customerMSISDN)) {
      return res.status(400).json({
        success: false,
        message: 'Numéro de téléphone invalide'
      });
    }

    const token = await authenticateMVola();

    const transactionData = {
      amount: amount.toString(),
      currency: "Ar",
      descriptionText: descriptionText || "Paiement Solarmakers",
      requestDate: new Date().toISOString(),
      debitParty: [{ key: "msisdn", value: customerMSISDN }],
      creditParty: [{ key: "msisdn", value: process.env.MVOLA_PARTNER_MSISDN }],
      metadata: [
        { key: "partnerName", value: process.env.MVOLA_PARTNER_NAME },
        { key: "fc", value: "USD" },
        { key: "amountFc", value: "1" }
      ],
      requestingOrganisationTransactionReference: correlationId || `SOLAR-${Date.now()}`
    };

    const response = await axios.post(
      `${MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/`,
      transactionData,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '1.0',
          'X-CorrelationID': correlationId || `SOLAR-${Date.now()}`,
          'UserLanguage': 'fr',
          'UserAccountIdentifier': `msisdn;${process.env.MVOLA_PARTNER_MSISDN}`,
          'partnerName': process.env.MVOLA_PARTNER_NAME,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache'
        }
      }
    );

    logger.info('Transaction initiated', {
      correlationId: response.data.serverCorrelationId,
      amount,
      customerMSISDN
    });

    res.json({
      success: true,
      message: 'Transaction initiée avec succès',
      data: response.data
    });

  } catch (error) {
    logger.error('Transaction initiation failed', { 
      error: error.message,
      response: error.response?.data
    });
    
    res.status(500).json({
      success: false,
      message: 'Erreur lors de l\'initiation',
      error: error.response?.data || error.message
    });
  }
});

// Vérifier statut transaction
app.get('/mvola/transaction/status/:correlationId', async (req, res) => {
  try {
    const { correlationId } = req.params;
    const token = await authenticateMVola();

    const response = await axios.get(
      `${MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/status/${correlationId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '1.0',
          'X-CorrelationID': correlationId,
          'UserLanguage': 'fr',
          'UserAccountIdentifier': `msisdn;${process.env.MVOLA_PARTNER_MSISDN}`,
          'partnerName': process.env.MVOLA_PARTNER_NAME,
          'Cache-Control': 'no-cache'
        }
      }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    logger.error('Status check failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la vérification',
      error: error.message
    });
  }
});

// Détails transaction
app.get('/mvola/transaction/details/:transactionId', async (req, res) => {
  try {
    const { transactionId } = req.params;
    const token = await authenticateMVola();

    const response = await axios.get(
      `${MVOLA_BASE_URL}/mvola/mm/transactions/type/merchantpay/1.0.0/${transactionId}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Version': '1.0',
          'X-CorrelationID': `DETAIL-${Date.now()}`,
          'UserLanguage': 'fr',
          'UserAccountIdentifier': `msisdn;${process.env.MVOLA_PARTNER_MSISDN}`,
          'partnerName': process.env.MVOLA_PARTNER_NAME,
          'Cache-Control': 'no-cache'
        }
      }
    );

    res.json({
      success: true,
      data: response.data
    });

  } catch (error) {
    logger.error('Details fetch failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Erreur lors de la récupération',
      error: error.message
    });
  }
});

// Callback MVola
app.put('/mvola/callback/:correlationId?', (req, res) => {
  try {
    const correlationId = req.params.correlationId || 'unknown';
    const callbackData = req.body;

    logger.info('MVola callback received', {
      correlationId,
      status: callbackData.transactionStatus,
      data: callbackData
    });

    // Ici vous pourriez traiter le callback
    // Ex: Mettre à jour une base de données, envoyer un email, etc.

    res.json({
      success: true,
      message: 'Callback traité avec succès'
    });

  } catch (error) {
    logger.error('Callback processing failed', { error: error.message });
    res.status(500).json({
      success: false,
      message: 'Erreur lors du traitement du callback'
    });
  }
});

// Gestion d'erreurs globale
app.use((error, req, res, next) => {
  logger.error('Unhandled error', { error: error.message, stack: error.stack });
  res.status(500).json({
    success: false,
    message: 'Erreur interne du serveur'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Endpoint non trouvé'
  });
});

app.listen(PORT, () => {
  logger.info(`🚀 MVola Middleware started on port ${PORT}`);
  logger.info(`Environment: ${process.env.NODE_ENV || 'development'}`);
  logger.info(`MVola API: ${MVOLA_BASE_URL}`);
});

module.exports = app; 
