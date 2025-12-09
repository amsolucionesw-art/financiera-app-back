// backend/src/models/VentaManual.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

/**
 * VENTA MANUAL: asienta ventas que no provienen del flujo de Recibos.
 * NOTA: El impacto en Caja (crear movimiento) se controla desde el service.
 *       Para ventas manuales FINANCIADAS, NO debe generar movimientos en Caja.
 */
const VentaManual = sequelize.define('VentaManual', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Fecha contable principal (imputación)
    fecha_imputacion: { type: DataTypes.DATEONLY, allowNull: false, comment: 'Fecha contable' },

    // Comprobante
    numero_comprobante: { type: DataTypes.STRING(50), allowNull: false },

    // Cliente (FK lógica a Cliente.id)
    cliente_id: { type: DataTypes.INTEGER, allowNull: false, comment: 'FK Cliente.id' },
    cliente_nombre: { type: DataTypes.STRING(200), allowNull: false },
    doc_cliente: { type: DataTypes.STRING(20), allowNull: true }, // CUIT/CUIL/DNI

    // Detalle del producto/servicio vendido (para ventas financiadas o normales)
    detalle_producto: {
        type: DataTypes.STRING(255),
        allowNull: true,
        comment: 'Descripción / detalle del producto vendido (originará detalle en el crédito si es financiada)'
    },

    // Desgloses
    neto: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    iva: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    ret_gan: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    ret_iva: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    ret_iibb_tuc: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },

    // Específico de financieras (si aplica)
    capital: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    /**
     * NOTA: si esta venta da origen a un crédito y desean imponer la tasa,
     * este campo se interpretará como % (ej. 60 = 60%). Para ventas manuales
     * financiadas, el interés es MANUAL (no aplicar reglas automáticas de crédito común).
     */
    interes: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    cuotas: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1, validate: { min: 1 } },

    // Periodicidad de la financiación (solo si da origen a un crédito)
    // Valores esperados: 'mensual', 'semanal', 'quincenal'
    tipo_credito: {
        type: DataTypes.STRING(20),
        allowNull: true,
        comment: 'Periodicidad asociada al crédito: mensual / semanal / quincenal'
    },

    // Total abonado
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },

    // Medio de pago (FK opcional)
    forma_pago_id: { type: DataTypes.INTEGER, allowNull: true },

    // Bonificación (si aplica)
    bonificacion: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    // Vendedor/Cobrador (texto libre)
    vendedor: { type: DataTypes.STRING(150), allowNull: true },

    // Útil para filtros contables
    mes: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    anio: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1900, max: 9999 } },

    observacion: { type: DataTypes.STRING(255), allowNull: true },

    // Integración Caja / Auditoría
    caja_movimiento_id: { type: DataTypes.INTEGER, allowNull: true },
    usuario_id: { type: DataTypes.INTEGER, allowNull: true },

    // Vínculo con crédito creado automáticamente (si la venta es financiada)
    credito_id: {
        type: DataTypes.INTEGER,
        allowNull: true,
        comment: 'FK lógico a Credito.id (si se generó desde esta venta)'
    },

}, {
    tableName: 'ventas_manuales',
    timestamps: false,
    indexes: [
        { fields: ['fecha_imputacion'] },
        { fields: ['mes', 'anio'] },
        { fields: ['cliente_id'] },
        { fields: ['cliente_nombre'] },
        { fields: ['numero_comprobante'] },
        // Índice para consultas por crédito originado en esta venta
        { fields: ['credito_id'] },
        // Opcional: facilitar búsquedas por detalle
        { fields: ['detalle_producto'] },
        // Opcional: facilitar filtros por tipo de crédito
        { fields: ['tipo_credito'] },
    ],
    hooks: {
        // Derivar mes/año desde fecha_imputacion si no vienen
        beforeValidate(instance) {
            if (!instance.mes || !instance.anio) {
                const d = instance.fecha_imputacion ? new Date(instance.fecha_imputacion) : null;
                if (d && !isNaN(d.getTime())) {
                    if (!instance.mes) instance.mes = d.getMonth() + 1;
                    if (!instance.anio) instance.anio = d.getFullYear();
                }
            }
        },
    },
});

export default VentaManual;