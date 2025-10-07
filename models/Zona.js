import { DataTypes } from 'sequelize';
import sequelize from './sequelize.js';

const Zona = sequelize.define('Zona', {
  nombre: { type: DataTypes.STRING, allowNull: false }
}, {
  tableName: 'zonas',
  timestamps: false
});

export default Zona;
