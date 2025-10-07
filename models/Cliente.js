import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Cliente = sequelize.define('Cliente', {
    nombre: { type: DataTypes.STRING(100), allowNull: true },
    apellido: { type: DataTypes.STRING(100), allowNull: true },
    dni: { type: DataTypes.STRING(20), allowNull: true },
    fecha_nacimiento: { type: DataTypes.DATEONLY, allowNull: true },
    fecha_registro: { type: DataTypes.DATEONLY, allowNull: true },
    email: { type: DataTypes.STRING(100), allowNull: true },

    telefono: { type: DataTypes.STRING(20), allowNull: true },
    telefono_secundario: { type: DataTypes.STRING(20), allowNull: true },

    direccion: { type: DataTypes.STRING(255), allowNull: true },
    direccion_secundaria: { type: DataTypes.STRING(255), allowNull: true },

    referencia_direccion: { type: DataTypes.STRING(255), allowNull: true },
    referencia_secundaria: { type: DataTypes.STRING(255), allowNull: true },

    observaciones: { type: DataTypes.TEXT, allowNull: true },

    historial_crediticio: {
        type: DataTypes.ENUM('Aprobado', 'Desaprobado'),
        allowNull: false,
        defaultValue: 'Desaprobado'
    },

    puntaje_crediticio: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },

    provincia: { type: DataTypes.STRING(100), allowNull: true },
    localidad: { type: DataTypes.STRING(100), allowNull: true },
    dni_foto: { type: DataTypes.STRING(255), allowNull: true },
    cobrador: { type: DataTypes.INTEGER, allowNull: true },
    zona: { type: DataTypes.INTEGER, allowNull: true }
}, {
    tableName: 'clientes',
    timestamps: false
});

export default Cliente;


