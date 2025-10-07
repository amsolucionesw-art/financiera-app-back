// services/usuario.service.js
import Usuario from '../models/Usuario.js';
import Role from '../models/Role.js';
import bcrypt from 'bcrypt';
import Zona from '../models/Zona.js';
import Cliente from '../models/Cliente.js';
import sequelize from '../models/sequelize.js';

// Obtener todos los usuarios
export const obtenerUsuarios = () =>
    Usuario.findAll({
        include: {
            model: Role,
            as: 'rol',
            attributes: ['id', 'nombre_rol']
        },
        attributes: { exclude: ['password'] }
    });

// Obtener un usuario por ID (ahora incluye zonas)
export const obtenerUsuarioPorId = (id) =>
    Usuario.findByPk(id, {
        include: [
            {
                model: Role,
                as: 'rol',
                attributes: ['id', 'nombre_rol']
            },
            {
                model: Zona,
                as: 'zonas',
                through: { attributes: [] },
                attributes: ['id', 'nombre']
            }
        ],
        attributes: { exclude: ['password'] }
    });

// Crear un nuevo usuario (con múltiples zonas si es cobrador)
export const crearUsuario = async (data) => {
    const hashedPassword = await bcrypt.hash(data.password, 10);
    const { zona_ids, ...datos } = data;

    const nuevoUsuario = await Usuario.create({
        ...datos,
        password: hashedPassword
    });

    // Si es cobrador y se pasaron zonas
    if (datos.rol_id === 2 && Array.isArray(zona_ids)) {
        await nuevoUsuario.setZonas(zona_ids);
    }

    return nuevoUsuario.id;
};

/**
 * Actualizar usuario (con soporte a:
 *  - cambio opcional de contraseña (hasheada)
 *  - manejo de zonas para rol cobrador
 *  - operación atómica con transacción
 */
export const actualizarUsuario = async (id, data) => {
    const t = await sequelize.transaction();
    try {
        // Desestructuramos lo que puede venir del formulario
        const {
            zona_ids,        // array opcional para cobradores
            password,        // string opcional; si viene no vacía, se actualiza
            ...camposActualizables
        } = { ...data };

        // Nunca persistimos password en plano dentro de "camposActualizables"
        // (se maneja aparte si corresponde)
        delete camposActualizables.password;

        // 1) Actualizamos los campos "normales"
        await Usuario.update(camposActualizables, {
            where: { id },
            transaction: t
        });

        // 2) Si vino una nueva password NO vacía, la hasheamos y actualizamos
        if (typeof password === 'string' && password.trim().length > 0) {
            const hashed = await bcrypt.hash(password.trim(), 10);
            await Usuario.update(
                { password: hashed },
                { where: { id }, transaction: t }
            );
        }

        // 3) Zonas (solo si el rol es cobrador = 2 y se envió zona_ids como array)
        if (camposActualizables.rol_id === 2 && Array.isArray(zona_ids)) {
            const usuario = await Usuario.findByPk(id, { transaction: t });
            if (usuario) {
                await usuario.setZonas(zona_ids, { transaction: t });
            }
        }

        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }
};

// Cambiar contraseña (endpoint dedicado)
export const cambiarPassword = async (id, nuevaPassword) => {
    const hashed = await bcrypt.hash(nuevaPassword, 10);
    await Usuario.update({ password: hashed }, { where: { id } });
};

// Eliminar usuario (verifica si es cobrador con clientes asignados)
export const eliminarUsuario = async (id) => {
    const usuario = await Usuario.findByPk(id);
    if (!usuario) {
        throw new Error('Usuario no encontrado');
    }

    // Si es cobrador (rol_id === 2), verificamos si tiene clientes asignados
    if (usuario.rol_id === 2) {
        // Se usa la columna 'cobrador' según tu modelo Cliente
        const clientesAsignados = await Cliente.count({ where: { cobrador: id } });
        if (clientesAsignados > 0) {
            throw new Error('No se puede eliminar un cobrador con clientes asignados');
        }
    }

    await Usuario.destroy({ where: { id } });
};

// Login
export const loginUsuario = async (nombre_usuario, password) => {
    const usuario = await Usuario.findOne({ where: { nombre_usuario } });
    if (!usuario) return null;
    const valid = await bcrypt.compare(password, usuario.password);
    return valid ? usuario : null;
};

/* ──────────────────────────────────────────────────────────
   COBRADORES (para selects dependientes en CrearCredito.jsx)
   ────────────────────────────────────────────────────────── */

// Básico: ideal para <select> (sin datos sensibles)
export const obtenerCobradoresBasico = async () => {
    const cobradores = await Usuario.findAll({
        where: { rol_id: 2 }, // 2 = cobrador
        attributes: ['id', 'nombre_completo'],
        order: [['nombre_completo', 'ASC']]
    });
    return cobradores;
};

// Con zonas: para cuando necesites mapear cobertura/filtrado por zona
export const obtenerCobradoresConZonas = async () => {
    try {
        const cobradores = await Usuario.findAll({
            where: { rol_id: 2 }, // 2 = cobrador
            attributes: { exclude: ['password'] },
            include: [
                {
                    model: Role,
                    as: 'rol',
                    attributes: ['id', 'nombre_rol']
                },
                {
                    model: Zona,
                    as: 'zonas',
                    through: { attributes: [] },
                    attributes: ['id', 'nombre']
                }
            ],
            order: [['nombre_completo', 'ASC']]
        });
        return cobradores;
    } catch (error) {
        console.error('Error al obtener cobradores con zonas:', error);
        throw error;
    }
};

// Azúcar: un único export para elegir formato
export const obtenerCobradores = async (options = {}) => {
    const { conZonas = false } = options;
    return conZonas ? obtenerCobradoresConZonas() : obtenerCobradoresBasico();
};

