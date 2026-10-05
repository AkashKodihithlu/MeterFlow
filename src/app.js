import express from 'express';
import cors from 'cors';
import { errorHandler } from './middleware/errorHandler.js';
import meterRoutes from './routes/meterRoutes.js';
import usageRoutes from './routes/usageRoutes.js';
import stripeRoutes from './routes/stripeRoutes.js';
import invoiceRoutes from './routes/invoiceRoutes.js';

export function createApp() {
  const app = express();

  // Basic security and parsing
  app.use(cors());

  // Capture raw body buffer for Stripe webhooks signature verification
  app.use(express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // URL encoded parser for form data
  app.use(express.urlencoded({ extended: true }));

  // Mount API route groups
  app.use('/', invoiceRoutes);
  app.use('/', meterRoutes);
  app.use('/', usageRoutes);
  app.use('/', stripeRoutes);

  // 404 handler for undefined routes
  app.use((req, res) => {
    res.status(404).json({
      error: 'NotFound',
      code: 404,
      message: `Endpoint '${req.method} ${req.originalUrl}' does not exist.`
    });
  });

  // Centralized boundary error handler
  app.use(errorHandler);

  return app;
}

export default createApp();
