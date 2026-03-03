// services/tareas.service.js

import TareaPendiente from '../models/Tarea_pendiente.js';
import Credito from '../models/Credito.js';
import Cuota from '../models/Cuota.js';
import { anularCredito } from './credito.service.js';
import Usuario from '../models/Usuario.js';
import Cliente from '../models/Cliente.js';
import { Op } from 'sequelize';

const parseDatosTarea = (datos) => {
    if (!datos) return {};
    if (typeof datos === 'object') return datos;
    if (typeof datos === 'string') {
        try {
            const parsed = JSON.parse(datos);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
            return {};
        }
    }
    return {};
};

const extractCreditoId = (tarea) => {
    const datos = parseDatosTarea(tarea?.datos);
    const raw = datos.creditoId ?? datos.credito_id ?? datos.id ?? null;

    if (raw === null || raw === undefined || String(raw).trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
};

export const crearTareaTest = async () => {
    try {
        const nuevaTarea = await TareaPendiente.create({
            tipo: 'eliminar_credito',
            datos: {
                creditoId: 123,
                motivo: 'Error en los datos simulada',
            },
            creadoPor: 1,
        });

        return nuevaTarea;
    } catch (error) {
        console.error('Error al crear tarea en el servicio:', error);
        throw new Error('Error al crear tarea de prueba: ' + error.message);
    }
};

export const aprobarTarea = async (id, aprobadoPor) => {
    const tarea = await TareaPendiente.findByPk(id);
    if (!tarea) throw new Error('Tarea no encontrada');
    if (tarea.estado !== 'pendiente') throw new Error('La tarea ya fue procesada');

    const datos = parseDatosTarea(tarea.datos);

    const { tipo } = tarea;
    console.log('[DEBUG] Tipo de tarea:', tipo);
    console.log('[DEBUG] Datos recibidos:', datos);

    switch (tipo) {
        case 'eliminar_credito': {
            const creditoId = Number(datos.creditoId);
            if (!Number.isFinite(creditoId) || creditoId <= 0) throw new Error('Falta el ID del crédito');

            const credito = await Credito.findByPk(creditoId);
            if (!credito) throw new Error('Crédito no encontrado');

            await Cuota.destroy({ where: { credito_id: creditoId } });
            await Credito.destroy({ where: { id: creditoId } });

            break;
        }

        case 'anular_credito': {
            const creditoId = Number(datos.creditoId);
            if (!Number.isFinite(creditoId) || creditoId <= 0) throw new Error('Falta el ID del crédito');

            await anularCredito(creditoId, aprobadoPor);
            break;
        }

        default:
            throw new Error(`Tipo de tarea no soportado: ${tipo}`);
    }

    tarea.estado = 'aprobada';
    tarea.aprobadoPor = aprobadoPor;
    tarea.fechaResolucion = new Date();
    await tarea.save();

    return tarea;
};

export const rechazarTarea = async (id, aprobadoPor) => {
    const tarea = await TareaPendiente.findByPk(id);
    if (!tarea) throw new Error('Tarea no encontrada');
    if (tarea.estado !== 'pendiente') throw new Error('La tarea ya fue procesada');

    tarea.estado = 'rechazada';
    tarea.aprobadoPor = aprobadoPor;
    tarea.fechaResolucion = new Date();
    await tarea.save();

    return tarea;
};

export const obtenerTareas = async ({ estado }) => {
    const where = {};
    if (estado) where.estado = estado;

    const tareas = await TareaPendiente.findAll({
        where,
        include: [
            {
                model: Usuario,
                as: 'creador',
                attributes: ['id', 'nombre_completo', 'nombre_usuario'],
            },
        ],
        order: [['fechaCreacion', 'DESC']],
    });

    // ✅ Normalizamos datos a objeto y devolvemos plain para que el front no sufra con JSON string
    const tareasPlain = tareas.map((t) => {
        const plain = t.get({ plain: true });
        const datos = parseDatosTarea(plain.datos);
        return { ...plain, datos };
    });

    // ✅ Enriquecer tareas de crédito con Cliente
    const creditoIds = Array.from(
        new Set(
            tareasPlain
                .filter((t) => t.tipo === 'anular_credito' || t.tipo === 'eliminar_credito')
                .map((t) => extractCreditoId(t))
                .filter(Boolean)
        )
    );

    if (creditoIds.length === 0) return tareasPlain;

    const creditos = await Credito.findAll({
        where: { id: { [Op.in]: creditoIds } },
        include: [
            {
                model: Cliente,
                as: 'cliente',
                attributes: ['id', 'nombre', 'apellido'],
            },
        ],
        attributes: ['id', 'cliente_id'],
        raw: false,
    });

    const creditosById = new Map(
        creditos.map((c) => {
            const dto = c.get({ plain: true });
            const nombre = dto.cliente ? `${dto.cliente.nombre} ${dto.cliente.apellido}` : null;
            return [
                dto.id,
                {
                    clienteId: dto.cliente?.id ?? dto.cliente_id ?? null,
                    clienteNombre: nombre,
                },
            ];
        })
    );

    return tareasPlain.map((t) => {
        const creditoId = extractCreditoId(t);
        if (!creditoId) return t;

        const info = creditosById.get(creditoId);
        if (!info) return t;

        return {
            ...t,
            datos: {
                ...t.datos,
                creditoId,
                clienteId: info.clienteId,
                clienteNombre: info.clienteNombre,
            },
        };
    });
};