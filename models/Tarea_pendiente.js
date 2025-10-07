import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';


    const TareaPendiente = sequelize.define('TareaPendiente', {
        tipo: {
            type: DataTypes.STRING,
            allowNull: false
        },
        datos: {
            type: DataTypes.JSONB,
            allowNull: false
        },
        estado: {
            type: DataTypes.ENUM('pendiente', 'aprobada', 'rechazada'),
            defaultValue: 'pendiente'
        },
        creadoPor: {
            type: DataTypes.INTEGER,
            allowNull: false
        },
        aprobadoPor: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        fechaResolucion: {
            type: DataTypes.DATE,
            allowNull: true
        }
    }, {
        tableName: 'tareas_pendientes',
        timestamps: true,
        createdAt: 'fechaCreacion',
        updatedAt: false
    });

export default TareaPendiente;
