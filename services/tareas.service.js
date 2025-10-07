import TareaPendiente from '../models/Tarea_pendiente.js';
import Credito from '../models/Credito.js';
import Cuota from '../models/Cuota.js';
import { anularCredito } from './credito.service.js';
import Usuario from '../models/Usuario.js';

export const crearTareaTest = async () => {
    try {
        const nuevaTarea = await TareaPendiente.create({
            tipo: 'eliminar_credito',
            datos: {
                creditoId: 123,
                motivo: 'Error en los datos simulada'
            },
            creadoPor: 1
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

    // ✅ Forzar el parseo si fuera string
    const datos = typeof tarea.datos === 'string' ? JSON.parse(tarea.datos) : tarea.datos;
    

    const { tipo } = tarea;
    console.log('[DEBUG] Tipo de tarea:', tipo);
    console.log('[DEBUG] Datos recibidos:', datos);
    switch (tipo) {
        case 'eliminar_credito': {
            const { creditoId } = datos;

            const credito = await Credito.findByPk(creditoId);
            if (!credito) throw new Error('Crédito no encontrado');

            await Cuota.destroy({ where: { credito_id: creditoId } });
            await Credito.destroy({ where: { id: creditoId } });

            break;
        }

        case 'anular_credito': {
            if (!datos.creditoId) throw new Error('Falta el ID del crédito');
            await anularCredito(datos.creditoId, aprobadoPor);
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
                attributes: ['id', 'nombre_completo', 'nombre_usuario']
            }
        ],
        order: [['fechaCreacion', 'DESC']]
    });

    return tareas;
};