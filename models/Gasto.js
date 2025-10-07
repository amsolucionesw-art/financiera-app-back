// backend/src/models/Gasto.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

/**
 * GASTO: egreso que NO requiere el detalle fiscal de una compra
 * (sin desgloses de IVA/percepciones). Ideal para viáticos, servicios,
 * gastos menores, etc. Impacta Caja como EGRESO por "total".
 */
const Gasto = sequelize.define('Gasto', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Fecha contable principal (imputación)
    fecha_imputacion: { type: DataTypes.DATEONLY, allowNull: false, comment: 'Fecha contable' },

    // Fecha del gasto (si difiere)
    fecha_gasto: { type: DataTypes.DATEONLY, allowNull: true },

    // Datos opcionales del comprobante
    tipo_comprobante: { type: DataTypes.STRING(50), allowNull: true }, // Ej: TICKET, REC, NC, etc.
    numero_comprobante: { type: DataTypes.STRING(50), allowNull: true },

    // Contraparte opcional (histórico/edición rápida)
    proveedor_nombre: { type: DataTypes.STRING(200), allowNull: true },
    proveedor_cuit: { type: DataTypes.STRING(20), allowNull: true },

    // ➕ NUEVO: referencia al maestro de proveedores
    proveedor_id: { type: DataTypes.INTEGER, allowNull: true, comment: 'FK proveedores.id' },

    // Concepto principal (obligatorio)
    concepto: { type: DataTypes.STRING(255), allowNull: false },

    // Monto total (obligatorio)
    total: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0.00,
        validate: { min: 0 } // el service validará > 0 para impactar caja
    },

    // Medio de pago (FK informativa)
    forma_pago_id: { type: DataTypes.INTEGER, allowNull: true },

    // Clasificación contable libre
    clasificacion: { type: DataTypes.STRING(100), allowNull: true },

    // Útil para filtros contables
    mes: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    anio: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1900, max: 9999 } },

    // Auditoría opcional (texto)
    gasto_realizado_por: { type: DataTypes.STRING(150), allowNull: true },

    observacion: { type: DataTypes.STRING(255), allowNull: true },

    // Integración Caja / Auditoría
    caja_movimiento_id: { type: DataTypes.INTEGER, allowNull: true },
    usuario_id: { type: DataTypes.INTEGER, allowNull: true },

}, {
    tableName: 'gastos',
    timestamps: false,
    indexes: [
        { fields: ['fecha_imputacion'] },
        { fields: ['mes', 'anio'] },
        { fields: ['proveedor_nombre'] },
        { fields: ['proveedor_id'] },         // ➕ índice para FK proveedor
        { fields: ['tipo_comprobante', 'numero_comprobante'] },
        { fields: ['clasificacion'] },
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

export default Gasto;