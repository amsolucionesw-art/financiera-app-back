// financiera-backend/services/credito.service.js
// Fachada: mantiene compatibilidad con imports existentes (routes/controllers)
// y delega a módulos internos por responsabilidad.

export * from './credito/credito.core.service.js';
export { obtenerResumenLibre, refreshCuotaLibre } from './credito/credito.libre.service.js';
export { imprimirFichaCredito } from './credito/credito.pdf.service.js';
