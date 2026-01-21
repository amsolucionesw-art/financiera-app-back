import Cliente from '../models/Cliente.js';
import Usuario from '../models/Usuario.js';
import Zona from '../models/Zona.js';
import Cuota from '../models/Cuota.js';
import FormaPago from '../models/FormaPago.js';
import { buildFilters } from '../utils/buildFilters.js';
import { Op } from 'sequelize';

/* ⬇️ NUEVO: lectura de CSV/XLSX */
import * as XLSX from 'xlsx';

/**
 * Feature flag para DNI FOTO
 * - Por defecto: APAGADO (no se expone ni se permite editar dni_foto)
 * - Para habilitar: setear DNI_FOTO_ENABLED=true en el entorno (Dokploy)
 */
const DNI_FOTO_ENABLED = String(process.env.DNI_FOTO_ENABLED || '').toLowerCase() === 'true';

/**
 * BASE_URL para absolutizar links (dni_foto).
 * Producción: seteá APP_BASE_URL o BASE_URL (ej: https://tudominio.com)
 * Dev: fallback al puerto local.
 */
const BASE_URL =
    (process.env.APP_BASE_URL || process.env.BASE_URL || '').replace(/\/+$/, '') ||
    `http://localhost:${process.env.PORT || 3000}`;

/* ──────────────────────────────────────────────────────────
   Helpers DNI / Errores
   ────────────────────────────────────────────────────────── */

const str = (v) => (v ?? '').toString().trim();
const cleanDni = (v) => str(v).replace(/\D+/g, ''); // deja solo dígitos

const isUniqueConstraintError = (e) =>
    e &&
    (e.name === 'SequelizeUniqueConstraintError' ||
        e.name === 'SequelizeValidationError' ||
        (Array.isArray(e?.errors) && e.errors.some((x) => x?.type === 'unique violation')));

const throwDniDuplicado = (dni) => {
    const msg = `Ya existe un cliente con ese documento (DNI: ${dni}).`;
    const err = new Error(msg);
    err.code = 'DNI_DUPLICADO';
    err.status = 409; // ideal para el controller
    throw err;
};

const throwDniInvalido = () => {
    const err = new Error('El documento (DNI) es requerido o inválido.');
    err.code = 'DNI_INVALIDO';
    err.status = 400;
    throw err;
};

const throwForbidden = (message = 'No autorizado') => {
    const err = new Error(message);
    err.status = 403;
    err.code = 'FORBIDDEN';
    throw err;
};

const assertDniDisponible = async (dni, { excludeId = null } = {}) => {
    if (!dni) throwDniInvalido();

    const where = excludeId ? { dni, id: { [Op.ne]: excludeId } } : { dni };

    const existing = await Cliente.findOne({
        where,
        attributes: ['id', 'dni'],
    });

    if (existing) throwDniDuplicado(dni);
};

/* ──────────────────────────────────────────────────────────
    LISTADOS (full y básico para selects)
   ────────────────────────────────────────────────────────── */

// 🟢 Obtener todos los clientes con filtros opcionales (listado completo)
export const obtenerClientes = async (query) => {
    const where = buildFilters(query, ['dni', 'zona', 'cobrador', 'apellido', 'localidad']);

    const clientes = await Cliente.findAll({
        where,
        include: [
            { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
            { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] },
        ],
    });

    // ✅ Sanitizamos salida para no exponer dni_foto si feature flag está apagado
    return (clientes || []).map((c) => {
        const plain = c?.toJSON ? c.toJSON() : c;
        if (!DNI_FOTO_ENABLED && plain && Object.prototype.hasOwnProperty.call(plain, 'dni_foto')) {
            delete plain.dni_foto;
        } else {
            absolutizeDniFoto(plain);
        }
        return plain;
    });
};

// 🟢 Obtener clientes en formato básico (ideal para <select>), con filtros opcionales
export const obtenerClientesBasico = async (query = {}) => {
    const where = buildFilters(query, ['dni', 'zona', 'cobrador', 'apellido', 'localidad']);

    return Cliente.findAll({
        where,
        // ✅ Incluimos DNI para poder mostrarlo en el selector
        attributes: ['id', 'nombre', 'apellido', 'dni', 'cobrador', 'zona'],
        order: [
            ['apellido', 'ASC'],
            ['nombre', 'ASC'],
        ],
    });
};

/* ──────────────────────────────────────────────────────────
   CRUD / CONSULTAS
   ────────────────────────────────────────────────────────── */

const absolutizeDniFoto = (plain) => {
    if (!plain) return plain;

    if (plain.dni_foto && typeof plain.dni_foto === 'string') {
        const s = plain.dni_foto.trim();
        // si ya viene absoluta, no tocamos
        if (/^https?:\/\//i.test(s)) return plain;

        // si viene como filename o path relativo, lo absolutizamos
        const filename = s.includes('/') ? s.split('/').filter(Boolean).pop() : s;
        plain.dni_foto = `${BASE_URL}/uploads/dni/${filename}`;
    }

    return plain;
};

/**
 * Para cartera del cobrador: estado “operativo” inferido por cuotas.
 * Prioridad: vencido > parcial > pendiente > pagado
 * Respeta estados terminales: refinanciado / anulado
 */
const inferEstadoCreditoDesdeCuotas = (creditoPlain) => {
    const estadoOriginal = String(creditoPlain?.estado || '').toLowerCase();

    // estados terminales (no los tocamos)
    if (estadoOriginal === 'refinanciado' || estadoOriginal === 'anulado') {
        return estadoOriginal;
    }

    const cuotas = Array.isArray(creditoPlain?.cuotas) ? creditoPlain.cuotas : [];
    if (cuotas.length === 0) return estadoOriginal || 'pendiente';

    const estados = cuotas.map((c) => String(c?.estado || '').toLowerCase());

    // todas pagadas => pagado
    if (estados.every((e) => e === 'pagado')) return 'pagado';

    // alguna vencida => vencido
    if (estados.some((e) => e === 'vencido' || e === 'vencida')) return 'vencido';

    // alguna parcial => parcial
    if (estados.some((e) => e === 'parcial')) return 'parcial';

    // alguna pendiente => pendiente
    if (estados.some((e) => e === 'pendiente')) return 'pendiente';

    // fallback
    return estadoOriginal || 'pendiente';
};

// 🟢 Obtener cliente por ID (incluye cobrador y zona)
export const obtenerClientePorId = async (id) => {
    const cliente = await Cliente.findByPk(id, {
        include: [
            { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
            { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] },
        ],
    });

    if (!cliente) return null;

    const plain = cliente.toJSON();

    // ✅ Si DNI_FOTO_ENABLED está apagado, NO exponemos dni_foto
    if (!DNI_FOTO_ENABLED && Object.prototype.hasOwnProperty.call(plain, 'dni_foto')) {
        delete plain.dni_foto;
    } else {
        absolutizeDniFoto(plain);
    }

    return plain;
};

// 🟢 Obtener clientes por cobrador con créditos y cuotas
export const obtenerClientesPorCobrador = async (cobradorId) => {
    const clientes = await Cliente.findAll({
        where: { cobrador: cobradorId },
        include: [
            { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
            { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] },
            {
                association: 'creditos',
                include: [
                    {
                        model: Cuota,
                        as: 'cuotas',
                        include: [{ model: FormaPago, as: 'formaPago', attributes: ['id', 'nombre'] }],
                    },
                ],
            },
        ],
    });

    // ✅ devolvemos plain JSON + estado coherente con cuotas (para evitar fichas “viejas”)
    return (clientes || []).map((c) => {
        const plain = c?.toJSON ? c.toJSON() : c;

        if (!DNI_FOTO_ENABLED && plain && Object.prototype.hasOwnProperty.call(plain, 'dni_foto')) {
            delete plain.dni_foto;
        } else {
            absolutizeDniFoto(plain);
        }

        if (Array.isArray(plain.creditos)) {
            plain.creditos = plain.creditos.map((cred) => {
                const estadoInferido = inferEstadoCreditoDesdeCuotas(cred);

                return {
                    ...cred,
                    // 🔥 clave: el front muestra y filtra por credito.estado
                    estado: estadoInferido,
                };
            });
        }

        return plain;
    });
};

// 🟢 Crear nuevo cliente (NO permite DNI duplicado)
export const crearCliente = async (data) => {
    const dniNormalizado = cleanDni(data?.dni);
    if (!dniNormalizado) throwDniInvalido();

    // ✅ Chequeo preventivo (UX) + evita duplicados por diferencias de formato
    await assertDniDisponible(dniNormalizado);

    try {
        const nuevoCliente = await Cliente.create({
            nombre: data.nombre,
            apellido: data.apellido,
            dni: dniNormalizado,
            fecha_nacimiento: data.fecha_nacimiento,
            fecha_registro: data.fecha_registro,
            email: data.email,
            telefono: data.telefono,
            telefono_secundario: data.telefono_secundario || null,
            direccion: data.direccion,
            direccion_secundaria: data.direccion_secundaria || null,
            referencia_direccion: data.referencia_direccion || null,
            referencia_secundaria: data.referencia_secundaria || null,
            observaciones: data.observaciones || null,
            provincia: data.provincia,
            localidad: data.localidad,
            cobrador: data.cobrador,
            zona: data.zona,
            // dni_foto: data.dni_foto || null, // ⛔️ Por ahora fuera de la importación (se mantiene el campo en el modelo)
            historial_crediticio: data.historial_crediticio || 'Desaprobado',
            puntaje_crediticio: data.puntaje_crediticio ?? 0,
        });

        return nuevoCliente.id;
    } catch (e) {
        // ✅ Backstop por si existe UNIQUE en DB (o carreras concurrentes)
        if (isUniqueConstraintError(e)) {
            throwDniDuplicado(dniNormalizado);
        }
        throw e;
    }
};

/**
 * 🟢 Actualizar cliente
 * Reglas:
 * - Superadmin (rol 0): puede editar DNI (validando duplicados) y resto de campos.
 * - Admin (rol 1): puede editar cliente PERO NO puede modificar DNI ni dni_foto (ni por PUT).
 *
 * Firma:
 *   actualizarCliente(id, data, { actorRoleId }?)
 */
export const actualizarCliente = async (id, data, { actorRoleId = null } = {}) => {
    const clienteActual = await Cliente.findByPk(id);
    if (!clienteActual) throw new Error('Cliente no encontrado');

    const clientePrevio = clienteActual.toJSON();

    // Normalizamos role
    const rol = actorRoleId != null ? Number(actorRoleId) : null;
    const esAdmin = rol === 1;

    // Clon defensivo (evita mutar referencia externa)
    const payload = data ? { ...data } : {};

    // ✅ Si la función de DNI FOTO está apagada, NO permitimos modificar dni_foto por API (ningún rol)
    if (!DNI_FOTO_ENABLED && Object.prototype.hasOwnProperty.call(payload, 'dni_foto')) {
        delete payload.dni_foto;
    }

    // ✅ Admin: no permitir cambios en dni_foto por PUT
    if (esAdmin && Object.prototype.hasOwnProperty.call(payload, 'dni_foto')) {
        delete payload.dni_foto;
    }

    // ✅ Admin: NO puede modificar DNI
    if (esAdmin && Object.prototype.hasOwnProperty.call(payload, 'dni')) {
        const dniNuevo = cleanDni(payload.dni);
        const dniPrevio = cleanDni(clientePrevio.dni);

        // si viene vacío o distinto => bloquear
        if (!dniNuevo || dniNuevo !== dniPrevio) {
            throwForbidden('Sin permisos: el rol admin no puede modificar el DNI del cliente.');
        }

        // Si vino igual, lo normalizamos (no cambia nada)
        payload.dni = dniPrevio;
    }

    // ✅ Superadmin (o sin actorRoleId): si intentan cambiar el DNI, validar contra duplicados
    if (!esAdmin && Object.prototype.hasOwnProperty.call(payload, 'dni')) {
        const dniNuevo = cleanDni(payload.dni);
        if (!dniNuevo) throwDniInvalido();

        const dniPrevio = cleanDni(clientePrevio.dni);
        if (dniNuevo !== dniPrevio) {
            await assertDniDisponible(dniNuevo, { excludeId: id });
        }

        // normalizamos lo que se guarda
        payload.dni = dniNuevo;
    }

    const datosActualizados = {
        ...clientePrevio,
        ...payload,
        // ✅ Si dni_foto está apagado, preservamos el valor previo sí o sí
        dni_foto: DNI_FOTO_ENABLED ? (payload.dni_foto ?? clientePrevio.dni_foto) : clientePrevio.dni_foto,
    };

    delete datosActualizados.id;

    try {
        await Cliente.update(datosActualizados, { where: { id } });
    } catch (e) {
        if (isUniqueConstraintError(e)) {
            const dniToReport = cleanDni(datosActualizados.dni);
            throwDniDuplicado(dniToReport);
        }
        throw e;
    }
};

// 🟢 Eliminar cliente por ID
export const eliminarCliente = (id) => Cliente.destroy({ where: { id } });

/* ──────────────────────────────────────────────────────────
   IMPORTACIÓN POR PLANILLA (CSV/XLSX)
   ────────────────────────────────────────────────────────── */

/**
 * Mapea encabezados posibles de la planilla a campos del modelo.
 * Podés agregar alias sin problemas (case-insensitive).
 */
const HEADER_MAP = {
    // requeridos
    nombre: 'nombre',
    apellido: 'apellido',
    dni: 'dni',

    // opcionales
    fecha_nacimiento: 'fecha_nacimiento',
    'fecha nacimiento': 'fecha_nacimiento',

    fecha_registro: 'fecha_registro',
    'fecha registro': 'fecha_registro',

    email: 'email',
    correo: 'email',

    telefono: 'telefono',
    telefono_1: 'telefono',
    teléfono: 'telefono',

    telefono_secundario: 'telefono_secundario',
    telefono_2: 'telefono_secundario',

    direccion: 'direccion',
    direccion_1: 'direccion',
    domicilio: 'direccion',

    direccion_secundaria: 'direccion_secundaria',
    direccion_2: 'direccion_secundaria',

    referencia_direccion: 'referencia_direccion',
    referencia_direccion_1: 'referencia_direccion',

    referencia_secundaria: 'referencia_secundaria',
    referencia_direccion_2: 'referencia_secundaria',

    observaciones: 'observaciones',

    provincia: 'provincia',
    localidad: 'localidad',

    // cobrador / zona (por id o por nombre)
    cobrador: 'cobrador',
    cobrador_id: 'cobrador',
    cobrador_nombre: 'cobrador_nombre',

    zona: 'zona',
    zona_id: 'zona',
    zona_nombre: 'zona_nombre',

    // (si más adelante lo agregan en template)
    historial_crediticio: 'historial_crediticio',
    puntaje_crediticio: 'puntaje_crediticio',
};

/** Helpers básicos */
const isEmpty = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const toDateOrNull = (v) => {
    if (isEmpty(v)) return null;
    if (v instanceof Date && !isNaN(v)) return v;

    // Excel numeric date
    if (typeof v === 'number') {
        const d = XLSX.SSF.parse_date_code(v);
        if (!d) return null;
        const dt = new Date(Date.UTC(d.y, (d.m || 1) - 1, d.d || 1));
        return isNaN(dt) ? null : dt;
    }

    const t = str(v);
    const dt = new Date(t);
    return isNaN(dt) ? null : dt;
};

/**
 * Normaliza una fila cruda (keys arbitrarias) a nuestro shape interno según HEADER_MAP.
 */
const normalizeRow = (raw) => {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (k == null) continue;
        const key = k.toString().trim().toLowerCase();
        const mapped = HEADER_MAP[key];
        if (mapped) out[mapped] = v;
    }
    return out;
};

/**
 * Busca IDs de cobrador/zona a partir de id directo o por nombre.
 */
const resolveCobradorYZona = async (row) => {
    let resolvedCobrador = null;
    let resolvedZona = null;

    // COBRADOR por ID
    if (!isEmpty(row.cobrador)) {
        const id = Number(row.cobrador);
        if (!Number.isNaN(id)) {
            const u = await Usuario.findByPk(id, { attributes: ['id'] });
            if (u) resolvedCobrador = u.id;
        }
    }

    // COBRADOR por nombre (case-insensitive)
    if (!resolvedCobrador && !isEmpty(row.cobrador_nombre)) {
        const nombre = str(row.cobrador_nombre).toLowerCase();
        const u = await Usuario.findOne({
            where: Usuario.sequelize.where(
                Usuario.sequelize.fn('LOWER', Usuario.sequelize.col('nombre_completo')),
                nombre
            ),
            attributes: ['id'],
        });
        if (u) resolvedCobrador = u.id;
    }

    // ZONA por ID
    if (!isEmpty(row.zona)) {
        const id = Number(row.zona);
        if (!Number.isNaN(id)) {
            const z = await Zona.findByPk(id, { attributes: ['id'] });
            if (z) resolvedZona = z.id;
        }
    }

    // ZONA por nombre (case-insensitive)
    if (!resolvedZona && !isEmpty(row.zona_nombre)) {
        const nombre = str(row.zona_nombre).toLowerCase();
        const z = await Zona.findOne({
            where: Zona.sequelize.where(
                Zona.sequelize.fn('LOWER', Zona.sequelize.col('nombre')),
                nombre
            ),
            attributes: ['id'],
        });
        if (z) resolvedZona = z.id;
    }

    return { cobrador: resolvedCobrador, zona: resolvedZona };
};

/**
 * Valida una fila normalizada. Devuelve array de errores (strings).
 */
const validateRow = (row) => {
    const errors = [];
    const dni = cleanDni(row.dni);

    if (isEmpty(row.nombre)) errors.push('El campo "nombre" es requerido.');
    if (isEmpty(row.apellido)) errors.push('El campo "apellido" es requerido.');
    if (isEmpty(dni)) errors.push('El campo "dni" es requerido o inválido.');

    if (!isEmpty(row.email)) {
        const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str(row.email));
        if (!ok) errors.push('El campo "email" tiene formato inválido.');
    }

    return { errors, dni };
};

/**
 * Convierte una fila normalizada al shape final compatible con crear/actualizar.
 */
const toClientPayload = (row, resolved) => ({
    nombre: str(row.nombre) || null,
    apellido: str(row.apellido) || null,
    dni: cleanDni(row.dni) || null,

    fecha_nacimiento: toDateOrNull(row.fecha_nacimiento),
    fecha_registro: toDateOrNull(row.fecha_registro),

    email: isEmpty(row.email) ? null : str(row.email),

    telefono: isEmpty(row.telefono) ? null : str(row.telefono),
    telefono_secundario: isEmpty(row.telefono_secundario) ? null : str(row.telefono_secundario),

    direccion: isEmpty(row.direccion) ? null : str(row.direccion),
    direccion_secundaria: isEmpty(row.direccion_secundaria) ? null : str(row.direccion_secundaria),

    referencia_direccion: isEmpty(row.referencia_direccion) ? null : str(row.referencia_direccion),
    referencia_secundaria: isEmpty(row.referencia_secundaria) ? null : str(row.referencia_secundaria),

    observaciones: isEmpty(row.observaciones) ? null : str(row.observaciones),

    provincia: isEmpty(row.provincia) ? null : str(row.provincia),
    localidad: isEmpty(row.localidad) ? null : str(row.localidad),

    cobrador: resolved.cobrador ?? null,
    zona: resolved.zona ?? null,

    historial_crediticio: isEmpty(row.historial_crediticio) ? undefined : str(row.historial_crediticio),
    puntaje_crediticio: isEmpty(row.puntaje_crediticio) ? undefined : Number(row.puntaje_crediticio),
});

const readBufferToRows = (buffer) => {
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const firstSheetName = wb.SheetNames[0];
    const sheet = wb.Sheets[firstSheetName];
    return XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
};

export const importarClientesDesdePlanilla = async (fileBuffer, filename, { dryRun = true } = {}) => {
    const rawRows = readBufferToRows(fileBuffer, filename);

    const results = [];
    let created = 0;
    let updated = 0;
    let errorsCount = 0;

    let index = 0;
    for (const raw of rawRows) {
        index += 1;

        const norm = normalizeRow(raw);
        const { errors: valErrors, dni } = validateRow(norm);

        let resolved = { cobrador: null, zona: null };
        if (valErrors.length === 0) {
            resolved = await resolveCobradorYZona(norm);
        }

        const payload = toClientPayload(norm, resolved);

        let action = null;
        let targetId = null;

        try {
            if (valErrors.length > 0) {
                errorsCount += 1;
                results.push({
                    index,
                    status: 'error',
                    action: null,
                    dni,
                    id: null,
                    errors: valErrors,
                    dataApplied: null,
                });
                continue;
            }

            const existing = await Cliente.findOne({ where: { dni } });

            if (!existing) {
                action = 'create';
                if (!dryRun) {
                    const createdClient = await Cliente.create({
                        ...payload,
                        historial_crediticio: payload.historial_crediticio ?? 'Desaprobado',
                        puntaje_crediticio: Number.isFinite(payload.puntaje_crediticio) ? payload.puntaje_crediticio : 0,
                    });
                    targetId = createdClient.id;
                    created += 1;
                } else {
                    created += 1;
                }
            } else {
                action = 'update';
                targetId = existing.id;
                if (!dryRun) {
                    const { dni: _omitDni, ...rest } = payload;
                    await Cliente.update(rest, { where: { id: existing.id } });
                    updated += 1;
                } else {
                    updated += 1;
                }
            }

            results.push({
                index,
                status: 'ok',
                action,
                dni,
                id: targetId,
                errors: [],
                dataApplied: payload,
            });
        } catch (e) {
            errorsCount += 1;

            let msg = e.message || 'Error inesperado al procesar la fila.';
            if (isUniqueConstraintError(e)) {
                msg = `DNI duplicado en base de datos (DNI: ${dni}).`;
            }

            results.push({
                index,
                status: 'error',
                action,
                dni,
                id: targetId,
                errors: [msg],
                dataApplied: payload,
            });
        }
    }

    const summary = {
        total: rawRows.length,
        created,
        updated,
        errors: errorsCount,
        dryRun,
    };

    return { summary, rows: results };
};