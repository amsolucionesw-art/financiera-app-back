// models/Recibo.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Recibo = sequelize.define('Recibo', {
    numero_recibo: {
        type: DataTypes.INTEGER,
        allowNull: false,
        autoIncrement: true,
        primaryKey: true
    },
    fecha: {
        type: DataTypes.DATEONLY,
        defaultValue: DataTypes.NOW
    },
    hora: {
        type: DataTypes.TIME,
        defaultValue: sequelize.literal("CURRENT_TIME")
    },
    cliente_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    cliente_nombre: {
        type: DataTypes.STRING(200),
        allowNull: false
    },
    monto_pagado: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false
    },
    concepto: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    saldo_anterior: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false
    },
    pago_a_cuenta: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false
    },
    saldo_actual: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false
    },
    nombre_cobrador: {
        type: DataTypes.STRING(150),
        allowNull: false
    },
    medio_pago: {
        type: DataTypes.STRING(100),
        allowNull: false
    },
    pago_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },
    cuota_id: {
        type: DataTypes.INTEGER,
        allowNull: false
    },

    // ── Campos de desglose ──
    importe_cuota_original: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    descuento_aplicado: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    mora_cobrada: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    principal_pagado: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    // Para modalidad "libre": interés del/los ciclo/s cobrado/s en liquidación total/adelantada
    interes_ciclo_cobrado: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    saldo_credito_anterior: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    },
    saldo_credito_actual: {
        type: DataTypes.DECIMAL(10,2),
        allowNull: false,
        defaultValue: 0.00
    }
}, {
    tableName: 'recibos',
    timestamps: false
});

export default Recibo;
