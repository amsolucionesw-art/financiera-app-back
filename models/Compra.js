// backend/src/models/Compra.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

/**
 * Compras
 * Mapea columnas contables:
 *  FECHA IMPUTACIÓN (fecha_imputacion)
 *  FECHA DE COMPR (fecha_compra)
 *  TIPO DE COMPROBANTE (tipo_comprobante)
 *  N° DE COMP (numero_comprobante)
 *  NOMBRE Y APELLIDO - RS (proveedor_nombre)
 *  CUIT-CUIL (proveedor_cuit)
 *  NETO (neto) | IVA (iva) | PER IVA (per_iva) | PER IIBB TUC (per_iibb_tuc) | PER TEM (per_tem) | TOTAL (total)
 *  DEPOSITO DESTINO (deposito_destino)
 *  REFERENCIA DE COMP (referencia_compra)
 *  CLASIFICACION (clasificacion)
 *  MES (mes) | AÑO (anio)
 *  FACTURADO A (facturado_a)
 *  GASTO REALIZADO POR (gasto_realizado_por)
 *
 * En caja: egreso automático por el total con referencia_tipo='compra'.
 *
 * NOTA (proveedor):
 *  - Se incorpora proveedor_id para relacionar con la tabla Proveedor (belongsTo).
 *  - Se mantienen proveedor_nombre y proveedor_cuit como redundancias útiles para informes/filtros.
 */
const Compra = sequelize.define('Compra', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    // Fechas
    fecha_imputacion: { type: DataTypes.DATEONLY, allowNull: false, comment: 'Fecha contable' },
    fecha_compra: { type: DataTypes.DATEONLY, allowNull: true, comment: 'Fecha del comprobante' },

    // Comprobante
    tipo_comprobante: { type: DataTypes.STRING(50), allowNull: false },
    numero_comprobante: { type: DataTypes.STRING(50), allowNull: false },

    // Proveedor (FK + redundancias para contabilidad)
    proveedor_id: { type: DataTypes.INTEGER, allowNull: true, comment: 'FK a Proveedor (associations.js)' },
    proveedor_nombre: { type: DataTypes.STRING(200), allowNull: false },
    proveedor_cuit: { type: DataTypes.STRING(20), allowNull: true },

    // Importes
    neto: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    iva: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    per_iva: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    per_iibb_tuc: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    per_tem: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },
    total: { type: DataTypes.DECIMAL(12, 2), allowNull: false, defaultValue: 0.00, validate: { min: 0 } },

    // Otros datos
    deposito_destino: { type: DataTypes.STRING(100), allowNull: true },
    referencia_compra: { type: DataTypes.STRING(200), allowNull: true },
    clasificacion: { type: DataTypes.STRING(100), allowNull: true },

    // Redundancias para filtros/agrupación contable
    mes: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1, max: 12 } },
    anio: { type: DataTypes.INTEGER, allowNull: false, validate: { min: 1900, max: 9999 } },

    facturado_a: { type: DataTypes.STRING(150), allowNull: true },
    gasto_realizado_por: { type: DataTypes.STRING(150), allowNull: true },
    observacion: { type: DataTypes.STRING(255), allowNull: true },

    // Relaciones informativas (se definen asociaciones en associations.js)
    forma_pago_id: { type: DataTypes.INTEGER, allowNull: true },
    caja_movimiento_id: { type: DataTypes.INTEGER, allowNull: true }, // link 1:1 al movimiento de caja (egreso)
    usuario_id: { type: DataTypes.INTEGER, allowNull: true }, // auditoría (quién cargó)
}, {
    tableName: 'compras',
    timestamps: false,
    indexes: [
        { fields: ['fecha_imputacion'] },
        { fields: ['mes', 'anio'] },
        { fields: ['proveedor_nombre'] },
        { fields: ['proveedor_id'] },
        { fields: ['tipo_comprobante', 'numero_comprobante'], unique: false },
    ],
    hooks: {
        // Si total viene 0, lo calculamos como suma de componentes
        beforeValidate(instance) {
            const toN = (v) => {
                const n = Number(v);
                return Number.isFinite(n) ? n : 0;
            };
            const total = toN(instance.total);
            if (!total || total <= 0) {
                const calc = toN(instance.neto) + toN(instance.iva) + toN(instance.per_iva)
                    + toN(instance.per_iibb_tuc) + toN(instance.per_tem);
                instance.total = calc.toFixed(2);
            }
            // Derivar mes/año desde fecha_imputacion si no vienen
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

export default Compra;