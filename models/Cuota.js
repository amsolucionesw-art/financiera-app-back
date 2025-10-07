// models/Cuota.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';
import FormaPago from './FormaPago.js';

const Cuota = sequelize.define('Cuota', {
    credito_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    numero_cuota: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    importe_cuota: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    fecha_vencimiento: {
        type: DataTypes.DATEONLY,
        allowNull: false
    },
    estado: {
        type: DataTypes.ENUM('pendiente', 'pagada', 'parcial', 'vencida'),
        allowNull: false,
        defaultValue: 'pendiente'
    },
    forma_pago_id: {
        type: DataTypes.INTEGER,
        allowNull: true
    },
    monto_pagado_acumulado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },

    // ——— Nuevos campos ———
    descuento_cuota: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    intereses_vencidos_acumulados: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    }
}, {
    tableName: 'cuotas',
    timestamps: false
});

Cuota.belongsTo(FormaPago, { foreignKey: 'forma_pago_id', as: 'formaPago' });

export default Cuota;
