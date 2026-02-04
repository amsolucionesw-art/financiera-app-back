// financiera-backend/services/cuota.service.js
// Fachada: mantiene compatibilidad con imports existentes.
// Nota: evitamos `export *` de LIBRE para no filtrar helpers internos y reducir choques.

export * from './cuota/cuota.core.service.js';

export {
    // API pública que suele consumirse desde controllers/services
    obtenerResumenLibrePorCredito,

    // Helpers útiles (si algún endpoint/report los usa desde afuera)
    deudaLibreTotalHoy,
    calcularInteresPendienteLibre,
    calcularMoraPendienteLibreExacto,

    // Constantes (por si UI/otros servicios las referencian)
    MORA_DIARIA_LIBRE,
    VTO_FICTICIO_LIBRE,
    LIBRE_MAX_CICLOS,

    // (opcional) si alguien la usa desde fuera
    cicloLibreActual
} from './cuota/cuota.libre.service.js';
