// backend/src/models/Proveedor.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

/**
 * PROVEEDOR (maestro)
 * - nombre_razon_social (requerido)
 * - cuil_cuit (requerido, único por índice)
 * - telefono, domicilio, ciudad, provincia, codigo_postal, rubro (opcionales)
 * - email (opcional)
 * - notas (opcional)
 * - activo (boolean, default true)
 */
const Proveedor = sequelize.define('Proveedor', {
    id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

    nombre_razon_social: {
        type: DataTypes.STRING(200),
        allowNull: false,
        comment: 'Nombre y apellido o razón social',
    },

    // ⬇️ único por índice (no por constraint directo en la columna)
    cuil_cuit: {
        type: DataTypes.STRING(20),
        allowNull: false,
        comment: 'CUIL/CUIT del proveedor',
    },

    telefono: { type: DataTypes.STRING(50), allowNull: true },
    domicilio: { type: DataTypes.STRING(200), allowNull: true },
    ciudad: { type: DataTypes.STRING(100), allowNull: true },
    provincia: { type: DataTypes.STRING(100), allowNull: true },
    codigo_postal: { type: DataTypes.STRING(20), allowNull: true },
    rubro: { type: DataTypes.STRING(100), allowNull: true },

    // Nuevos/compatibles con el service y el front:
    email: { type: DataTypes.STRING(200), allowNull: true },
    notas: { type: DataTypes.TEXT, allowNull: true },

    // Para filtrar y estado por defecto:
    activo: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },

    creado_en: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
}, {
    tableName: 'proveedores',
    timestamps: false,
    indexes: [
        // ÚNICO por índice (correcto para Postgres)
        { unique: true, fields: ['cuil_cuit'] },
        { fields: ['nombre_razon_social'] },
        { fields: ['rubro'] },
        { fields: ['ciudad', 'provincia'] },
        { fields: ['activo'] }, // útil para filtros activos/inactivos
    ],
});

export default Proveedor;

