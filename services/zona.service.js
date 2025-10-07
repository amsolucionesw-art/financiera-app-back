// backend/src/services/zona.service.js
import Zona from '../models/Zona.js';
import { Op } from 'sequelize';

// Helper: normaliza nombre
const normalizeName = (v) => String(v ?? '').trim();

// Obtener todas las zonas (ordenadas por nombre)
export const obtenerZonas = () => {
    return Zona.findAll({
        order: [['nombre', 'ASC']]
    });
};

// Obtener una zona por ID
export const obtenerZonaPorId = (id) => {
    return Zona.findByPk(id);
};

// Crear nueva zona
export const crearZona = async (data) => {
    const nombre = normalizeName(data?.nombre);
    if (!nombre) {
        // Mantengo throw simple; la ruta decidirá el status/shape de respuesta
        throw new Error('El nombre es obligatorio');
    }

    // Evitar duplicados
    const existente = await Zona.findOne({ where: { nombre } });
    if (existente) {
        throw new Error('Ya existe una zona con ese nombre');
    }

    const zona = await Zona.create({ nombre });
    // Mantengo tu contrato: devolver el id
    return zona.id;
};

// Actualizar zona
export const actualizarZona = async (id, data) => {
    const nombre = normalizeName(data?.nombre);
    if (!nombre) {
        throw new Error('El nombre es obligatorio');
    }

    // Evitar duplicados con otras zonas
    const conflicto = await Zona.findOne({
        where: {
            nombre,
            id: { [Op.ne]: id }
        }
    });
    if (conflicto) {
        throw new Error('Ya existe otra zona con ese nombre');
    }

    await Zona.update({ nombre }, { where: { id } });
};

// Eliminar zona
export const eliminarZona = async (id) => {
    // Mantengo tu contrato actual: destroy directo (devuelve 0/1)
    // Si querés proteger contra eliminación en uso (Clientes asignados),
    // lo agregamos luego con una verificación previa.
    return await Zona.destroy({ where: { id } });
};
