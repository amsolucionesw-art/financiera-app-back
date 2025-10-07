import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const FormaPago = sequelize.define('FormaPago', {
    nombre: { type: DataTypes.STRING(50), allowNull: false }
}, {
    tableName: 'formas_pago',
    timestamps: false
});

export default FormaPago;
