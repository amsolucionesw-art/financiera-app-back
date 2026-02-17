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
        defaultValue: sequelize.literal('CURRENT_TIME')
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
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    concepto: {
        type: DataTypes.STRING(255),
        allowNull: false
    },
    saldo_anterior: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    pago_a_cuenta: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false
    },
    saldo_actual: {
        type: DataTypes.DECIMAL(10, 2),
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

    // ✅ Modalidad del crédito asociada al recibo (para filtros y cálculo LIBRE por ciclo).
    // NULL para compat con recibos históricos.
    modalidad_credito: {
        type: DataTypes.STRING(20),
        allowNull: true,
        defaultValue: null,
        validate: {
            isIn: {
                args: [['comun', 'progresivo', 'libre']],
                msg: 'modalidad_credito inválida'
            }
        }
    },

    // ✅ Para modalidad "libre": ciclo al que se imputó el recibo (1..3)
    ciclo_libre: {
        type: DataTypes.SMALLINT,
        allowNull: true,
        defaultValue: null,
        validate: {
            min: 1,
            max: 3
        }
    },

    // ✅ NUEVO: cómo se aplicó el descuento (para auditoría/UX)
    // - descuento_sobre: 'mora' | 'total' (NULL para recibos históricos)
    // - descuento_porcentaje: porcentaje solicitado (0..100) (NULL para recibos históricos)
    descuento_sobre: {
        type: DataTypes.STRING(10),
        allowNull: true,
        defaultValue: null,
        validate: {
            isIn: {
                args: [['mora', 'total']],
                msg: 'descuento_sobre inválido (mora|total)'
            }
        }
    },
    descuento_porcentaje: {
        // Guardamos porcentaje (no monto), ej: 10.00
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
        defaultValue: null,
        validate: {
            min: 0,
            max: 100
        }
    },

    // ── Campos de desglose ──
    importe_cuota_original: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    descuento_aplicado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    mora_cobrada: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    principal_pagado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    interes_ciclo_cobrado: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    saldo_credito_anterior: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },
    saldo_credito_actual: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00
    },

    // 🟦 Saldo de mora pendiente (alias de columna para compatibilidad con la DB)
    //     - Atributo JS: saldo_mora
    //     - Columna en BD: saldo_mora_pendiente
    saldo_mora: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: false,
        defaultValue: 0.00,
        field: 'saldo_mora_pendiente'
    }
}, {
    tableName: 'recibos',
    timestamps: false
});

export default Recibo;