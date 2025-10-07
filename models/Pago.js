// backend/src/models/Pago.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Pago = sequelize.define('Pago', {
    id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true
    },
    cuota_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    monto_pagado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    fecha_pago: {
        type: DataTypes.DATEONLY,
        allowNull: false,
        defaultValue: DataTypes.NOW
    },
    forma_pago_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    observacion: {
        type: DataTypes.STRING(255),
        allowNull: true
    }
}, {
    tableName: 'pagos',
    timestamps: false,
    indexes: [
        { fields: ['cuota_id'] },
        { fields: ['fecha_pago'] },
        { fields: ['forma_pago_id'] },
    ]
});

export default Pago;
