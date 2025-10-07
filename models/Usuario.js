import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';
import Role from './Role.js';

const Usuario = sequelize.define('Usuario', {
    nombre_completo: { type: DataTypes.STRING, allowNull: false },
    nombre_usuario: { type: DataTypes.STRING, allowNull: false, unique: true },
    password: { type: DataTypes.STRING, allowNull: false },
    estado: { type: DataTypes.ENUM('activo', 'inactivo'), defaultValue: 'activo' },
    fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, {
    tableName: 'usuarios',
    timestamps: false
});

Usuario.belongsTo(Role, { foreignKey: 'rol_id', as: 'rol' });

export default Usuario;
