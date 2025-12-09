// backend/src/routes/credito.routes.js

import { Router } from 'express';
import verifyToken from '../middleware/verifyToken.js';
import checkRole from '../middleware/checkRole.js';
import {
    obtenerCreditos,
    obtenerCreditoPorId,
    crearCredito,
    actualizarCredito,
    eliminarCredito,
    obtenerCreditosPorCliente,
    cancelarCredito,
    esCreditoEliminable,
    obtenerResumenLibre,
    refinanciarCredito,
    imprimirFichaCredito
} from '../services/credito.service.js';

const router = Router();

/* ───────────── Helpers ───────────── */
const TIPOS_VALIDOS = new Set(['semanal', 'quincenal', 'mensual']);
const MODS_VALIDAS = new Set(['comun', 'progresivo', 'libre']);
const ESTADOS_VALIDOS = new Set(['pendiente', 'parcial', 'vencido', 'pagado', 'refinanciado', 'anulado']);
const DESCUENTO_SOBRE_VALIDOS = new Set(['mora', 'total']); // ← nuevo
const isValidYMD = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const isNum = (v) => v !== null && v !== undefined && !Number.isNaN(Number(v));
const isInt = (v) => Number.isInteger(Number(v));

/**
 * Longitud de período según tipo_credito:
 * - semanal   → 4 períodos/mes
 * - quincenal → 2 períodos/mes
 * - mensual   → 1 período/mes
 * (misma lógica que en credito.service.js)
 */
const periodLengthFromTipo = (tipo_credito) => {
    const t = String(tipo_credito || '').toLowerCase();
    if (t === 'semanal') return 4;
    if (t === 'quincenal') return 2;
    return 1; // mensual por defecto
};

/**
 * Interés proporcional mínimo 60% (común / progresivo):
 *   - semanal   → 60% * (semanas / 4)
 *   - quincenal → 60% * (quincenas / 2)
 *   - mensual   → 60% * (meses)
 * (misma regla que en credito.service.js)
 */
const calcularInteresProporcionalMin60 = (tipo_credito, cantidad_cuotas) => {
    const n = Math.max(Number(cantidad_cuotas) || 0, 1);
    const pl = periodLengthFromTipo(tipo_credito);
    const proporcional = 60 * (n / pl);
    return Math.max(60, proporcional);
};

/**
 * Construye las cuotas para simulación SIN tocar la base.
 * Respeta la lógica de generarCuotasServicio:
 *  - modalidad = 'progresivo' → cuotas crecientes (suma i/sum)
 *  - modalidad = 'comun'     → cuotas fijas
 * Si se envía fecha_compromiso_pago (YYYY-MM-DD), calcula fecha_vencimiento
 * igual que el servicio real (7/15/30 días por cuota según tipo_credito).
 */
const construirCuotasPreview = ({
    modalidad_credito,
    cantidad_cuotas,
    tipo_credito,
    monto_total_devolver,
    fecha_compromiso_pago
}) => {
    const mod = String(modalidad_credito || '').toLowerCase();
    const nRaw = Number(cantidad_cuotas) || 0;
    const n = Math.max(nRaw, 1);
    const M = Number(monto_total_devolver) || 0;

    const cuotasArr = [];

    if (mod === 'progresivo') {
        const sum = (n * (n + 1)) / 2;
        let acumulado = 0;
        for (let i = 1; i <= n; i++) {
            const importe = parseFloat((M * (i / sum)).toFixed(2));
            cuotasArr.push({ numero_cuota: i, importe_cuota: importe });
            acumulado += importe;
        }
        const diff = parseFloat((M - acumulado).toFixed(2));
        cuotasArr[n - 1].importe_cuota = parseFloat(
            (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
        );
    } else {
        // comun (PLAN DE CUOTAS FIJAS)
        const fija = parseFloat((M / n).toFixed(2));
        for (let i = 1; i <= n; i++) {
            cuotasArr.push({ numero_cuota: i, importe_cuota: fija });
        }
        const totalCalc = fija * n;
        const diff = parseFloat((M - totalCalc).toFixed(2));
        cuotasArr[n - 1].importe_cuota = parseFloat(
            (cuotasArr[n - 1].importe_cuota + diff).toFixed(2)
        );
    }

    // Fechas de vencimiento (opcionales)
    if (fecha_compromiso_pago && isValidYMD(fecha_compromiso_pago)) {
        const [year, month, day] = fecha_compromiso_pago
            .split('-')
            .map((x) => parseInt(x, 10));

        // Para evitar importar date-fns aquí, usamos Date nativo + sumatoria de días
        const baseDate = new Date(year, month - 1, day);

        const diasPorPeriodo =
            String(tipo_credito).toLowerCase() === 'semanal'
                ? 7
                : String(tipo_credito).toLowerCase() === 'quincenal'
                    ? 15
                    : 30;

        cuotasArr.forEach((c) => {
            const offsetDias = diasPorPeriodo * c.numero_cuota;
            const d = new Date(baseDate);
            d.setDate(d.getDate() + offsetDias);
            const yyyy = d.getFullYear();
            const mm = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            c.fecha_vencimiento = `${yyyy}-${mm}-${dd}`;
        });
    } else {
        // Si no se envía fecha_compromiso_pago, devolvemos sin fecha_vencimiento
        cuotasArr.forEach((c) => {
            c.fecha_vencimiento = null;
        });
    }

    return cuotasArr;
};

/**
 * Valida el payload para crear/actualizar créditos.
 * Devuelve un array de strings con errores. Si está vacío, pasa validación.
 * - isUpdate=false: validaciones de requeridos mínimas para creación
 * - isUpdate=true: todos los campos son opcionales pero, si vienen, deben ser válidos
 */
function validarPayloadCredito(body = {}, isUpdate = false) {
    const errors = [];
    const {
        cliente_id,
        modalidad_credito,
        tipo_credito,
        interes,
        cantidad_cuotas,
        monto_acreditar,
        estado,
        descuento,
        fecha_solicitud,
        fecha_acreditacion,
        cobrador_id
    } = body ?? {};

    // cliente_id
    if (!isUpdate || cliente_id !== undefined) {
        if (!isNum(cliente_id) || Number(cliente_id) <= 0) {
            errors.push('cliente_id es requerido y debe ser numérico positivo');
        }
    }

    // modalidad_credito
    if (!isUpdate || modalidad_credito !== undefined) {
        const mod = String(modalidad_credito || '').toLowerCase();
        if (!MODS_VALIDAS.has(mod)) {
            errors.push('modalidad_credito inválida (comun|progresivo|libre)');
        }
    }

    // tipo_credito (requerido incluso para "libre" para calcular ciclos)
    if (!isUpdate || tipo_credito !== undefined) {
        const t = String(tipo_credito || '').toLowerCase();
        if (!TIPOS_VALIDOS.has(t)) {
            errors.push('tipo_credito inválido (semanal|quincenal|mensual)');
        }
    }

    // interes (acepta 0 o mayor; el service normaliza si viene 60 -> 0.60)
    if (!isUpdate || interes !== undefined) {
        if (!isNum(interes) || Number(interes) < 0) {
            errors.push('interes debe ser numérico y ≥ 0');
        }
    }

    // cantidad_cuotas (para no-libre: ≥1; para libre suele ser 1, pero no forzamos)
    if (!isUpdate || cantidad_cuotas !== undefined) {
        if (!isNum(cantidad_cuotas) || !isInt(cantidad_cuotas) || Number(cantidad_cuotas) < 1) {
            errors.push('cantidad_cuotas debe ser entero ≥ 1');
        }
    }

    // monto_acreditar (capital inicial)
    if (!isUpdate || monto_acreditar !== undefined) {
        if (!isNum(monto_acreditar) || Number(monto_acreditar) <= 0) {
            errors.push('monto_acreditar es requerido y debe ser numérico > 0');
        }
    }

    // estado (si viene)
    if (estado !== undefined) {
        const e = String(estado || '').toLowerCase();
        if (!ESTADOS_VALIDOS.has(e)) {
            errors.push('estado inválido');
        }
    }

    // descuento (si viene) 0..100
    if (descuento !== undefined) {
        if (!isNum(descuento) || Number(descuento) < 0 || Number(descuento) > 100) {
            errors.push('descuento debe estar entre 0 y 100 (porcentaje)');
        }
    }

    // fechas (opcionales). Permitimos fechas pasadas para tests de cuotas vencidas.
    if (fecha_solicitud !== undefined && fecha_solicitud !== null && fecha_solicitud !== '') {
        if (!isValidYMD(fecha_solicitud)) {
            errors.push('fecha_solicitud debe ser YYYY-MM-DD');
        }
    }
    if (fecha_acreditacion !== undefined && fecha_acreditacion !== null && fecha_acreditacion !== '') {
        if (!isValidYMD(fecha_acreditacion)) {
            errors.push('fecha_acreditacion debe ser YYYY-MM-DD');
        }
    }

    // cobrador_id (si viene)
    if (cobrador_id !== undefined && cobrador_id !== null && cobrador_id !== '') {
        if (!isNum(cobrador_id) || Number(cobrador_id) <= 0) {
            errors.push('cobrador_id debe ser numérico positivo si se envía');
        }
    }

    return errors;
}

/**
 * Validador específico para SIMULACIÓN (no requiere cliente_id, ni fechas obligatorias).
 * Se usa en POST /creditos/simular
 */
function validarPayloadSimulacion(body = {}) {
    const errors = [];
    const {
        modalidad_credito,
        tipo_credito,
        cantidad_cuotas,
        monto_acreditar,
        fecha_compromiso_pago,
        descuento
    } = body ?? {};

    // modalidad_credito
    const mod = String(modalidad_credito || '').toLowerCase();
    if (!MODS_VALIDAS.has(mod)) {
        errors.push('modalidad_credito inválida (comun|progresivo|libre)');
    }

    // tipo_credito
    const t = String(tipo_credito || '').toLowerCase();
    if (!TIPOS_VALIDOS.has(t)) {
        errors.push('tipo_credito inválido (semanal|quincenal|mensual)');
    }

    // cantidad_cuotas
    if (!isNum(cantidad_cuotas) || !isInt(cantidad_cuotas) || Number(cantidad_cuotas) < 1) {
        errors.push('cantidad_cuotas debe ser entero ≥ 1');
    }

    // monto_acreditar
    if (!isNum(monto_acreditar) || Number(monto_acreditar) <= 0) {
        errors.push('monto_acreditar es requerido y debe ser numérico > 0');
    }

    // fecha_compromiso_pago (si viene)
    if (fecha_compromiso_pago !== undefined && fecha_compromiso_pago !== null && fecha_compromiso_pago !== '') {
        if (!isValidYMD(fecha_compromiso_pago)) {
            errors.push('fecha_compromiso_pago debe ser YYYY-MM-DD');
        }
    }

    // descuento (si viene) 0..100
    if (descuento !== undefined) {
        if (!isNum(descuento) || Number(descuento) < 0 || Number(descuento) > 100) {
            errors.push('descuento debe estar entre 0 y 100 (porcentaje) en la simulación');
        }
    }

    return errors;
}

/* 1) Créditos por cliente (con filtros opcionales)
   Query soportada:
   - estado: pendiente|parcial|vencido|pagado|refinanciado|anulado
   - modalidad: comun|progresivo|libre
   - tipo: semanal|quincenal|mensual
   - desde, hasta: YYYY-MM-DD
   - conCuotasVencidas: 1|true
*/
router.get(
    '/cliente/:clienteId',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const clienteId = Number(req.params.clienteId);

            // Sanitizar/validar query sin romper compatibilidad
            const q = {};
            const { estado, modalidad, tipo, desde, hasta, conCuotasVencidas } = req.query || {};

            if (estado && ESTADOS_VALIDOS.has(String(estado).toLowerCase())) {
                q.estado = String(estado).toLowerCase();
            }
            if (modalidad && MODS_VALIDAS.has(String(modalidad).toLowerCase())) {
                q.modalidad = String(modalidad).toLowerCase();
            }
            if (tipo && TIPOS_VALIDOS.has(String(tipo).toLowerCase())) {
                q.tipo = String(tipo).toLowerCase();
            }
            if (desde) {
                if (!isValidYMD(desde)) {
                    return res.status(400).json({ success: false, message: 'El parámetro "desde" debe ser YYYY-MM-DD' });
                }
                q.desde = desde;
            }
            if (hasta) {
                if (!isValidYMD(hasta)) {
                    return res.status(400).json({ success: false, message: 'El parámetro "hasta" debe ser YYYY-MM-DD' });
                }
                q.hasta = hasta;
            }
            if (conCuotasVencidas !== undefined) {
                const val = String(conCuotasVencidas).toLowerCase();
                q.conCuotasVencidas = (val === '1' || val === 'true');
            }

            // Pasamos rol_id al service para aplicar reglas de visualización
            const cliente = await obtenerCreditosPorCliente(clienteId, q, { rol_id: req.user.rol_id });
            if (!cliente) {
                return res.status(404).json({ success: false, message: 'Cliente no encontrado' });
            }
            res.json({ success: true, data: cliente });
        } catch (error) {
            console.error('Error al obtener créditos del cliente:', error);
            res.status(500).json({ success: false, message: 'Error al obtener créditos del cliente' });
        }
    }
);

/* 1.0) SIMULAR crédito (para Cotizador: comun/progresivo)
   NO toca la base. Devuelve:
   - interes (porcentaje total aplicado, mínimo 60% según tipo/cantidad)
   - monto_total_devolver
   - cuotas: [{ numero_cuota, importe_cuota, fecha_vencimiento? }]
*/
router.post(
    '/simular',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const errores = validarPayloadSimulacion(req.body);
            if (errores.length) {
                return res.status(400).json({
                    success: false,
                    message: 'Validación',
                    errors: errores
                });
            }

            const {
                modalidad_credito,
                tipo_credito,
                cantidad_cuotas,
                monto_acreditar,
                descuento = 0,
                fecha_compromiso_pago
            } = req.body;

            const mod = String(modalidad_credito || '').toLowerCase();

            // Para ahora nos enfocamos en comun y progresivo.
            // Si quisieras, más adelante podemos extender a libre con sus reglas propias.
            if (!['comun', 'progresivo'].includes(mod)) {
                return res.status(400).json({
                    success: false,
                    message: 'La simulación actualmente sólo soporta modalidades "comun" y "progresivo".'
                });
            }

            // Interés proporcional mínimo 60% (misma regla que en el service real)
            const interesPct = calcularInteresProporcionalMin60(tipo_credito, cantidad_cuotas);

            // capital + interés lineal
            let totalBase = Number(
                (Number(monto_acreditar) * (1 + interesPct / 100)).toFixed(2)
            );

            // Descuento opcional sólo si el usuario es superadmin (igual que en crearCredito)
            let descuentoPct = 0;
            if (req.user?.rol_id === 0 && Number(descuento) > 0) {
                descuentoPct = Number(descuento);
                const discMonto = Number((totalBase * descuentoPct) / 100).toFixed(2);
                totalBase = Number((totalBase - discMonto).toFixed(2));
            }

            // Construcción de cuotas (misma lógica que generarCuotasServicio)
            const cuotas = construirCuotasPreview({
                modalidad_credito: mod,
                cantidad_cuotas,
                tipo_credito,
                monto_total_devolver: totalBase,
                fecha_compromiso_pago
            });

            return res.json({
                success: true,
                data: {
                    modalidad_credito: mod,
                    tipo_credito,
                    cantidad_cuotas: Number(cantidad_cuotas),
                    monto_acreditar: Number(monto_acreditar),
                    interes: interesPct,
                    descuento: descuentoPct,
                    monto_total_devolver: totalBase,
                    cuotas
                }
            });
        } catch (error) {
            console.error('Error al simular crédito:', error);
            return res.status(500).json({
                success: false,
                message: 'Error al simular crédito'
            });
        }
    }
);

/* 1.1) Ficha PDF del crédito (¡antes que "/:id" para no colisionar!) */
router.get(
    '/:id/ficha.pdf',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            await imprimirFichaCredito(req, res);
        } catch (error) {
            console.error('Error al imprimir ficha PDF:', error);
            res.status(500).json({ success: false, message: 'Error al generar la ficha del crédito' });
        }
    }
);

/* 1.2) Obtener crédito por ID */
router.get(
    '/:id',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const id = Number(req.params.id);
            const credito = await obtenerCreditoPorId(id, { rol_id: req.user.rol_id });

            if (!credito) {
                return res.status(404).json({ success: false, message: 'Crédito no encontrado' });
            }

            res.json({ success: true, data: credito });
        } catch (error) {
            console.error('Error al obtener crédito por id:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al obtener crédito' });
        }
    }
);

/* 1.3) (REUBICADA) Pre-chequeo de eliminabilidad (solo superadmin) */
router.get(
    '/:id/eliminable',
    verifyToken, checkRole([0]),
    async (req, res) => {
        try {
            const { eliminable, cantidadPagos } = await esCreditoEliminable(req.params.id);
            res.json({ success: true, data: { eliminable, cantidadPagos } });
        } catch (error) {
            console.error('Error al verificar eliminabilidad del crédito:', error);
            res.status(500).json({ success: false, message: 'Error al verificar eliminabilidad del crédito' });
        }
    }
);

/* 2) Resumen LIBRE (capital, interés hoy, total) */
router.get(
    '/:id/resumen-libre',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const { fecha } = req.query; // opcional: YYYY-MM-DD
            if (fecha && !isValidYMD(fecha)) {
                return res.status(400).json({ success: false, message: 'El parámetro "fecha" debe ser YYYY-MM-DD' });
            }
            const refDate = fecha ? new Date(fecha) : new Date();
            const data = await obtenerResumenLibre(Number(req.params.id), refDate);
            res.json({ success: true, data });
        } catch (error) {
            console.error('Error al obtener resumen libre:', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen libre' });
        }
    }
);

/* 2.1) Alias compat */
router.get(
    '/:id/libre/resumen',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const { fecha } = req.query;
            if (fecha && !isValidYMD(fecha)) {
                return res.status(400).json({ success: false, message: 'El parámetro "fecha" debe ser YYYY-MM-DD' });
            }
            const refDate = fecha ? new Date(fecha) : new Date();
            const data = await obtenerResumenLibre(Number(req.params.id), refDate);
            res.json({ success: true, data });
        } catch (error) {
            console.error('Error al obtener resumen libre (alias):', error);
            res.status(500).json({ success: false, message: 'Error al obtener resumen libre' });
        }
    }
);

/* 3) Obtener todos los créditos */
router.get(
    '/',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const lista = await obtenerCreditos(req.query, { rol_id: req.user.rol_id });
            res.json({ success: true, data: lista });
        } catch (error) {
            console.error('Error al obtener créditos:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al obtener créditos' });
        }
    }
);

/* 4) Crear crédito */
router.post(
    '/',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const errors = validarPayloadCredito(req.body, false);
            if (errors.length) {
                return res.status(400).json({ success: false, message: 'Validación', errors });
            }

            // Pasamos rol_id y usuario_id al service
            const id = await crearCredito({
                ...req.body,
                rol_id: req.user.rol_id,
                usuario_id: req.user.id
            });

            const credito = await obtenerCreditoPorId(id, { rol_id: req.user.rol_id });
            res.status(201).json({
                success: true,
                message: 'Crédito creado exitosamente',
                data: credito
            });
        } catch (error) {
            console.error('Error al crear crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al crear crédito' });
        }
    }
);

/* 4.1) Refinanciar crédito (P1/P2/Manual) */
router.post(
    '/:id/refinanciar',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const { opcion, tasaManual = 0, tipo_credito, cantidad_cuotas } = req.body || {};
            const valid = ['P1', 'P2', 'manual'];
            if (!valid.includes(opcion)) {
                return res.status(400).json({ success: false, message: 'Opción inválida (P1, P2 o manual)' });
            }
            if (tipo_credito && !TIPOS_VALIDOS.has(String(tipo_credito).toLowerCase())) {
                return res.status(400).json({ success: false, message: 'tipo_credito inválido' });
            }

            const nuevoId = await refinanciarCredito({
                creditoId: Number(req.params.id),
                opcion,
                tasaManual,
                tipo_credito,
                cantidad_cuotas: cantidad_cuotas ? Number(cantidad_cuotas) : undefined,
                rol_id: req.user.rol_id
            });

            const creditoNuevo = await obtenerCreditoPorId(nuevoId, { rol_id: req.user.rol_id });
            res.status(201).json({
                success: true,
                message: 'Crédito refinanciado exitosamente',
                data: creditoNuevo
            });
        } catch (error) {
            console.error('Error al refinanciar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al refinanciar crédito' });
        }
    }
);

/* 5) Actualizar crédito */
router.put(
    '/:id',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const errors = validarPayloadCredito(req.body, true);
            if (errors.length) {
                return res.status(400).json({ success: false, message: 'Validación', errors });
            }

            await actualizarCredito(req.params.id, {
                ...req.body,
                rol_id: req.user.rol_id
            });

            const credito = await obtenerCreditoPorId(req.params.id, { rol_id: req.user.rol_id });
            res.json({
                success: true,
                message: 'Crédito actualizado exitosamente',
                data: credito
            });
        } catch (error) {
            console.error('Error al actualizar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al actualizar crédito' });
        }
    }
);

/* 6) Eliminar crédito */
router.delete(
    '/:id',
    verifyToken, checkRole([0]),
    async (req, res) => {
        try {
            // Pre-chequeo para evitar error de FK y dar mensaje claro
            const { eliminable, cantidadPagos } = await esCreditoEliminable(req.params.id);
            if (!eliminable) {
                return res.status(409).json({
                    success: false,
                    message: `No se puede eliminar el crédito porque tiene pagos registrados (${cantidadPagos}).`
                });
            }

            const resp = await eliminarCredito(req.params.id);
            res.json({ success: true, message: resp?.mensaje || 'Crédito eliminado exitosamente' });
        } catch (error) {
            console.error('Error al eliminar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({
                success: false,
                message: error?.message || 'Error al eliminar crédito'
            });
        }
    }
);

/* 7) Cancelar crédito (UN recibo) */
router.post(
    '/:id/cancelar',
    verifyToken, checkRole([0, 1]),
    async (req, res) => {
        try {
            const {
                forma_pago_id,
                descuento_porcentaje = 0,
                descuento_sobre = 'mora', // ← nuevo (mora|total)
                observacion = null
            } = req.body || {};

            // Validación básica de modo de descuento
            if (descuento_sobre && !DESCUENTO_SOBRE_VALIDOS.has(String(descuento_sobre))) {
                return res.status(400).json({
                    success: false,
                    message: 'descuento_sobre inválido (usar "mora" o "total")'
                });
            }

            const data = await cancelarCredito({
                credito_id: Number(req.params.id),
                forma_pago_id,
                descuento_porcentaje,
                descuento_sobre,
                observacion,
                rol_id: req.user.rol_id,
                // 👇 nuevo: usuario que cancela el crédito
                usuario_id: req.user.id
            });
            res.json({ success: true, message: 'Crédito cancelado', data });
        } catch (error) {
            console.error('Error al cancelar crédito:', error);
            const status = error?.status || 500;
            res.status(status).json({ success: false, message: error?.message || 'Error al cancelar crédito' });
        }
    }
);

export default router;