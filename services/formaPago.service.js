import FormaPago from '../models/FormaPago.js';

// Obtener todas las formas de pago
export const obtenerFormasPago = async () => {
    return await FormaPago.findAll({ attributes: ['id', 'nombre'] });
};

// Obtener una forma de pago por ID
export const obtenerFormaPagoPorId = async (id) => {
    return await FormaPago.findByPk(id);
};

// Crear nueva forma de pago
export const crearFormaPago = async (data) => {
    return await FormaPago.create(data);
};

// Actualizar forma de pago
export const actualizarFormaPago = async (id, data) => {
    const formaPago = await FormaPago.findByPk(id);
    if (!formaPago) return null;
    await formaPago.update(data);
    return formaPago;
};

// Eliminar forma de pago
export const eliminarFormaPago = async (id) => {
    return await FormaPago.destroy({ where: { id } });
};
