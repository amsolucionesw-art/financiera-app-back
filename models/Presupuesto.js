// src/models/Presupuesto.js
import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Presupuesto = sequelize.define(
    'Presupuesto',
    {
        numero: {
            type: DataTypes.INTEGER,
            allowNull: false,
            unique: true
        },
        nombre_destinatario: {
            type: DataTypes.STRING(150),
            allowNull: false
        },
        fecha_creacion: {
            type: DataTypes.DATEONLY,
            allowNull: false
        },
        monto_financiado: {
            type: DataTypes.DECIMAL(14, 2),
            allowNull: false
        },
        cantidad_cuotas: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        interes: {
            type: DataTypes.DECIMAL(5, 2),
            allowNull: false
        },
        valor_por_cuota: {
            type: DataTypes.DECIMAL(14, 2),
            allowNull: false
        },
        total_a_pagar: {
            type: DataTypes.DECIMAL(14, 2),
            allowNull: false
        },
        tipo_credito: {
            // periodicidad: mensual / quincenal / semanal, etc.
            type: DataTypes.STRING(20),
            allowNull: false
        },
        modalidad_credito: {
            // plan: libre / comun / progresivo
            type: DataTypes.STRING(20),
            allowNull: true
        },
        emitido_por: {
            // nombre del usuario / asesor que emite el presupuesto
            type: DataTypes.STRING(150),
            allowNull: true
        }
    },
    {
        tableName: 'presupuestos'
    }
);

export default Presupuesto;
