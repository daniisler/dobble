'use strict';
// Loads ".env" from the project root (if there is one) into process.env. Real environment variables win.
try { process.loadEnvFile(require('path').join(__dirname, '..', '.env')); } catch { /* no .env file: fine */ }
