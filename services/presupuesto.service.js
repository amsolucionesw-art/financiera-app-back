// src/services/presupuesto.service.js

import { Presupuesto } from '../models/index.js';
import { Op } from 'sequelize';

// Crea un nuevo presupuesto
export const crearPresupuesto = async (data) => {
    const presupuesto = await Presupuesto.create(data);
    return presupuesto;
};

// Devuelve todos los presupuestos, ordenados por número
export const obtenerPresupuestos = async () => {
    return await Presupuesto.findAll({
        order: [['numero', 'ASC']]
    });
};

// Busca presupuestos por ID (pk) o nombre_destinatario
export const buscarPresupuestos = async (filtro) => {
    const where = {};
    if (filtro.id) {
        where.id = filtro.id;
    }
    if (filtro.nombre_destinatario) {
        where.nombre_destinatario = { [Op.iLike]: `%${filtro.nombre_destinatario}%` };
    }
    return await Presupuesto.findAll({
        where,
        order: [['numero', 'ASC']]
    });
};

// Obtiene un único presupuesto por su campo `numero`
export const obtenerPresupuestoPorNumero = async (numero) => {
    return await Presupuesto.findOne({ where: { numero } });
};
