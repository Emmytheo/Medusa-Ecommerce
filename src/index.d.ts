export declare module "@medusajs/medusa/dist/models/store" {
    declare interface Store {
      members?: User[];
      products?: Product[];
    }
  }
  
  export declare module "@medusajs/medusa/dist/models/order" {
    declare interface Order {
      store_id: string;
      order_parent_id: string;
      store: Store;
      parent: Order;
      children: Order[];
    }
  }
  export declare module "@medusajs/medusa/dist/models/user" {
    declare interface User {
      store_id?: string;
      store?: Store;
    }
  }
  
  export declare module "@medusajs/medusa/dist/models/product" {
    declare interface Product {
      store_id?: string;
      store?: Store;
    }
  }