import Cliente from '../models/Cliente.js';
import Usuario from '../models/Usuario.js';
import Zona from '../models/Zona.js';
import Credito from '../models/Credito.js';
import Cuota from '../models/Cuota.js';
import FormaPago from '../models/FormaPago.js';
import { buildFilters } from '../utils/buildFilters.js';

const BASE_URL = 'http://localhost:3000'; // Centralizado

/* ──────────────────────────────────────────────────────────
   LISTADOS (full y básico para selects)
   ────────────────────────────────────────────────────────── */

// 🟢 Obtener todos los clientes con filtros opcionales (listado completo)
export const obtenerClientes = async (query) => {
    const where = buildFilters(query, ['dni', 'zona', 'cobrador', 'apellido', 'localidad']);

    return Cliente.findAll({
        where,
        include: [
            { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
            { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] }
        ]
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
            ['nombre', 'ASC']
        ]
    });
};

/* ──────────────────────────────────────────────────────────
   CRUD / CONSULTAS
   ────────────────────────────────────────────────────────── */

// 🟢 Obtener cliente por ID (incluye cobrador y zona)
export const obtenerClientePorId = async (id) => {
    const cliente = await Cliente.findByPk(id, {
        include: [
            { model: Usuario, as: 'cobradorUsuario', attributes: ['id', 'nombre_completo'] },
            { model: Zona, as: 'clienteZona', attributes: ['id', 'nombre'] }
        ]
    });

    if (!cliente) return null;

    const plain = cliente.toJSON();
    if (plain.dni_foto && !plain.dni_foto.startsWith('http')) {
        plain.dni_foto = `${BASE_URL}/uploads/dni/${plain.dni_foto}`;
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
                        include: [
                            { model: FormaPago, as: 'formaPago', attributes: ['id', 'nombre'] }
                        ]
                    }
                ]
            }
        ]
    });

    return clientes;
};

// 🟢 Crear nuevo cliente
export const crearCliente = async (data) => {
    const nuevoCliente = await Cliente.create({
        nombre: data.nombre,
        apellido: data.apellido,
        dni: data.dni,
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
        dni_foto: data.dni_foto || null,
        historial_crediticio: data.historial_crediticio || 'Desaprobado',
        puntaje_crediticio: data.puntaje_crediticio ?? 0
    });

    return nuevoCliente.id;
};

// 🟢 Actualizar cliente manteniendo imagen anterior si no se manda nueva
export const actualizarCliente = async (id, data) => {
    const clienteActual = await Cliente.findByPk(id);
    if (!clienteActual) throw new Error('Cliente no encontrado');

    const clientePrevio = clienteActual.toJSON();

    const datosActualizados = {
        ...clientePrevio,
        ...data,
        dni_foto: data.dni_foto ?? clientePrevio.dni_foto
    };

    delete datosActualizados.id;

    await Cliente.update(datosActualizados, { where: { id } });
};

// 🟢 Eliminar cliente por ID
export const eliminarCliente = (id) =>
    Cliente.destroy({ where: { id } });
