// File: packages/server/src/response-guard.ts

import type { ServerResponse } from 'http';
import type { _Streamer } from './streamer';

/**
 * ResponseGuard prevents double-sending responses and provides
 * safe methods for sending responses after checking state.
 */
export class ResponseGuard {
    private _sent = false;
    private _streamEnded = false;
    
    constructor(
        private response: ServerResponse,
        private streamer: _Streamer
    ) {
        // Monitor response lifecycle
        this.response.on('finish', () => {
            this._sent = true;
            this._streamEnded = true;
        });
        
        this.response.on('close', () => {
            this._streamEnded = true;
        });
        
        this.response.on('error', (err) => {
            console.error('Response stream error:', err);
            this._streamEnded = true;
        });
    }
    
    /**
     * Check if response has been sent or stream has ended
     */
    isSent(): boolean {
        return this._sent || 
               this.response.headersSent || 
               this.response.writableEnded || 
               this._streamEnded;
    }
    
    /**
     * Check if stream is still writable
     */
    isWritable(): boolean {
        return !this.response.destroyed && 
               !this.response.writableEnded && 
               !this._streamEnded;
    }
    
    /**
     * Safely send a buffer response
     */
    async sendBuffer(buffer: Buffer, contentType: string = 'text/html'): Promise<boolean> {
        if (this.isSent()) {
            console.warn('[ResponseGuard] Cannot send buffer - response already sent');
            return false;
        }
        
        if (!this.isWritable()) {
            console.warn('[ResponseGuard] Cannot send buffer - stream not writable');
            return false;
        }
        
        try {
            this._sent = true;
            this.streamer.sendBuffer(buffer, contentType);
            return true;
        } catch (error) {
            console.error('[ResponseGuard] Error sending buffer:', error);
            this._sent = false; // Reset if send failed
            return false;
        }
    }
    
    /**
     * Safely send an admin page
     */
    async sendAdmin(content: string): Promise<boolean> {
        if (this.isSent()) {
            console.warn('[ResponseGuard] Cannot send admin page - response already sent');
            return false;
        }
        
        if (!this.isWritable()) {
            console.warn('[ResponseGuard] Cannot send admin page - stream not writable');
            return false;
        }
        
        try {
            this._sent = true;
            await this.streamer.sendAdmin(content);
            return true;
        } catch (error) {
            console.error('[ResponseGuard] Error sending admin page:', error);
            this._sent = false;
            return false;
        }
    }
    
    /**
     * Safely send an error response
     */
    async sendError(statusCode: number, message: string): Promise<boolean> {
        if (this.isSent()) {
            console.warn('[ResponseGuard] Cannot send error - response already sent');
            return false;
        }
        
        if (!this.isWritable()) {
            console.warn('[ResponseGuard] Cannot send error - stream not writable');
            // Try to end gracefully if possible
            if (!this.response.writableEnded) {
                this.response.end();
            }
            return false;
        }
        
        try {
            this._sent = true;
            
            if (!this.response.headersSent) {
                this.response.writeHead(statusCode, {
                    'Content-Type': 'text/html; charset=utf-8'
                });
            }
            
            this.response.end(`
                <!DOCTYPE html>
                <html>
                <head><title>Error ${statusCode}</title></head>
                <body>
                    <h1>Error ${statusCode}</h1>
                    <p>${message}</p>
                </body>
                </html>
            `);
            return true;
        } catch (error) {
            console.error('[ResponseGuard] Error sending error response:', error);
            return false;
        }
    }
    
    /**
     * Get debug information about response state
     */
    getDebugInfo(): object {
        return {
            sent: this._sent,
            streamEnded: this._streamEnded,
            headersSent: this.response.headersSent,
            writableEnded: this.response.writableEnded,
            destroyed: this.response.destroyed,
            writable: this.isWritable(),
            canSend: !this.isSent()
        };
    }
}
