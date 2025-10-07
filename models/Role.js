import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Role = sequelize.define('Role', {
    nombre_rol: {
        type: DataTypes.STRING,
        allowNull: false,
        unique: true
    }
}, {
    tableName: 'roles',
    timestamps: false
});

export default Role;