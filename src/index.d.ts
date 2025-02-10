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
    wallet_id?: string | null; // Add wallet_id as nullable
    wallet?: Wallet | null; // Add wallet as nullable
  }
}

export declare module "@medusajs/medusa/dist/models/product" {
  declare interface Product {
    store_id?: string;
    store?: Store;
  }
}

export declare module "models/wallet-account" {
  declare interface WalletAccount {
    wallet: Wallet;
    wallet_id: string;
    currency: string;
    account_numbers: string[];
    balance: number;
    transactions: WalletAccountTransaction[];
  }
}

// // If Wallet is not already imported, import it as well
// import { Wallet } from "../models/wallet";
