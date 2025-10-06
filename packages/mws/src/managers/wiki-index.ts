// File: packages/mws/src/managers/wiki-index.ts

import type { IncomingMessage, ServerResponse } from 'http';
import type { _Streamer } from '@mws/server/src/streamer';
import type { _Router } from '@mws/server/src/router';
import { ResponseGuard } from '@mws/server/src/response-guard';

interface WikiIndexRoute {
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse, streamer: _Streamer, guard: ResponseGuard) => Promise<void>;
}

export class WikiIndexManager {
    private routes: Map<string, WikiIndexRoute> = new Map();
    
    constructor(private router: _Router) {
        this.setupRoutes();
    }
    
    private setupRoutes() {
        // Wiki index route
        this.router.addRoute({
            path: '/wiki/:wikiName',
            method: 'GET',
            handler: this.handleWikiIndex.bind(this),
            catchHandler: this.handleError.bind(this)
        });
    }
    
    /**
     * Main handler for wiki index pages
     */
    private async handleWikiIndex(
        req: IncomingMessage, 
        res: ServerResponse, 
        streamer: _Streamer
    ): Promise<void> {
        // Create response guard at the start of request handling
        const guard = new ResponseGuard(res, streamer);
        
        console.log('[WikiIndex] Request:', req.url);
        console.log('[WikiIndex] Initial state:', guard.getDebugInfo());
        
        try {
            // Extract wiki name from URL
            const wikiName = this.extractWikiName(req.url);
            
            if (!wikiName) {
                console.error('[WikiIndex] No wiki name found in URL:', req.url);
                await guard.sendError(400, 'Invalid wiki URL');
                return;
            }
            
            console.log('[WikiIndex] Processing wiki:', wikiName);
            
            // Check if wiki exists
            const wikiExists = await this.checkWikiExists(wikiName);
            
            if (!wikiExists) {
                console.error('[WikiIndex] Wiki not found:', wikiName);
                await guard.sendError(404, `Wiki "${wikiName}" not found`);
                return;
            }
            
            // Load wiki content
            const wikiContent = await this.loadWikiContent(wikiName);
            
            // Check guard before sending response
            if (guard.isSent()) {
                console.warn('[WikiIndex] Response already sent, skipping content send');
                return;
            }
            
            // Send the wiki page
            const success = await guard.sendBuffer(
                Buffer.from(wikiContent),
                'text/html; charset=utf-8'
            );
            
            if (!success) {
                console.error('[WikiIndex] Failed to send wiki content');
            } else {
                console.log('[WikiIndex] Successfully sent wiki content');
            }
            
        } catch (error) {
            console.error('[WikiIndex] Error in handleWikiIndex:', error);
            
            // Check if we can still send error response
            if (!guard.isSent()) {
                await guard.sendError(500, 'Internal server error');
            } else {
                console.error('[WikiIndex] Cannot send error - response already sent');
                console.error('[WikiIndex] State:', guard.getDebugInfo());
            }
            
            // Re-throw so catchHandler can log
            throw error;
        }
    }
    
    /**
     * Global error handler for wiki index routes
     * This is called when an error occurs in the handler
     */
    private async handleError(
        error: Error,
        req: IncomingMessage,
        res: ServerResponse,
        streamer: _Streamer
    ): Promise<void> {
        // Create or retrieve response guard
        const guard = new ResponseGuard(res, streamer);
        
        console.error('=== WIKI INDEX ERROR HANDLER ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('URL:', req.url);
        console.error('Response State:', guard.getDebugInfo());
        console.error('================================');
        
        // Special handling for STREAM_ENDED symbol error
        if (error.message?.includes('STREAM_ENDED') || String(error).includes('STREAM_ENDED')) {
            console.error('[WikiIndex] Stream ended unexpectedly - client may have disconnected');
            
            // Don't attempt to send response if stream ended
            if (!guard.isWritable()) {
                console.error('[WikiIndex] Stream not writable, cannot send error page');
                return;
            }
        }
        
        // Check if we've already sent a response
        if (guard.isSent()) {
            console.error('[WikiIndex] Response already sent, cannot send error page');
            console.error('[WikiIndex] This indicates a double-response attempt');
            
            // Log the response lifecycle for debugging
            console.error('[WikiIndex] Final state:', guard.getDebugInfo());
            return;
        }
        
        // Check if stream is still writable
        if (!guard.isWritable()) {
            console.error('[WikiIndex] Response stream not writable');
            
            // Try graceful termination
            if (!res.writableEnded && !res.destroyed) {
                try {
                    res.end();
                    console.log('[WikiIndex] Successfully ended response stream');
                } catch (endError) {
                    console.error('[WikiIndex] Failed to end stream:', endError);
                }
            }
            return;
        }
        
        // Attempt to send error page
        try {
            const errorPageContent = this.generateErrorPage(error, req);
            const success = await guard.sendAdmin(errorPageContent);
            
            if (success) {
                console.log('[WikiIndex] Successfully sent error page');
            } else {
                console.error('[WikiIndex] Failed to send error page');
                
                // Last resort: try basic error response
                if (guard.isWritable()) {
                    await guard.sendError(500, 'Internal Server Error');
                }
            }
        } catch (sendError) {
            console.error('[WikiIndex] Exception while sending error page:', sendError);
            
            // Absolute last resort
            if (!res.headersSent && !res.writableEnded && !res.destroyed) {
                try {
                    res.writeHead(500, { 'Content-Type': 'text/plain' });
                    res.end('Internal Server Error');
                } catch (finalError) {
                    console.error('[WikiIndex] Even final error response failed:', finalError);
                }
            }
        }
    }
    
    /**
     * Extract wiki name from URL
     */
    private extractWikiName(url: string | undefined): string | null {
        if (!url) return null;
        
        const match = url.match(/\/wiki\/([^/?]+)/);
        return match ? match[1] : null;
    }
    
    /**
     * Check if wiki exists
     */
    private async checkWikiExists(wikiName: string): Promise<boolean> {
        // TODO: Implement actual wiki existence check
        // This should check your wiki storage/database
        
        // Example implementation:
        // return await this.wikiStorage.exists(wikiName);
        
        // For now, return true - replace with actual logic
        return true;
    }
    
    /**
     * Load wiki content
     */
    private async loadWikiContent(wikiName: string): Promise<string> {
        // TODO: Implement actual wiki content loading
        // This should load the wiki HTML from your storage
        
        // Example implementation:
        // return await this.wikiStorage.loadContent(wikiName);
        
        // For now, return placeholder - replace with actual logic
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <title>${wikiName}</title>
                <meta charset="utf-8">
            </head>
            <body>
                <h1>${wikiName}</h1>
                <p>Wiki content goes here...</p>
            </body>
            </html>
        `;
    }
    
    /**
     * Generate error page HTML
     */
    private generateErrorPage(error: Error, req: IncomingMessage): string {
        const isDevelopment = process.env.NODE_ENV === 'development';
        
        return `
            <!DOCTYPE html>
            <html>
            <head>
                <title>Error - Wiki Index</title>
                <meta charset="utf-8">
                <style>
                    body {
                        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                        max-width: 800px;
                        margin: 50px auto;
                        padding: 20px;
                        background: #f5f5f5;
                    }
                    .error-container {
                        background: white;
                        padding: 30px;
                        border-radius: 8px;
                        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                    }
                    h1 {
                        color: #d32f2f;
                        margin-top: 0;
                    }
                    .error-message {
                        background: #ffebee;
                        padding: 15px;
                        border-radius: 4px;
                        border-left: 4px solid #d32f2f;
                        margin: 20px 0;
                    }
                    .error-details {
                        background: #f5f5f5;
                        padding: 15px;
                        border-radius: 4px;
                        font-family: monospace;
                        font-size: 12px;
                        overflow-x: auto;
                        display: ${isDevelopment ? 'block' : 'none'};
                    }
                    .back-link {
                        display: inline-block;
                        margin-top: 20px;
                        color: #1976d2;
                        text-decoration: none;
                    }
                    .back-link:hover {
                        text-decoration: underline;
                    }
                </style>
            </head>
            <body>
                <div class="error-container">
                    <h1>⚠️ Wiki Index Error</h1>
                    
                    <div class="error-message">
                        <strong>Error:</strong> ${this.escapeHtml(error.message)}
                    </div>
                    
                    <p><strong>URL:</strong> ${this.escapeHtml(req.url || 'unknown')}</p>
                    
                    ${isDevelopment ? `
                        <details>
                            <summary>Stack Trace (Development Only)</summary>
                            <div class="error-details">
                                ${this.escapeHtml(error.stack || 'No stack trace available')}
                            </div>
                        </details>
                    ` : ''}
                    
                    <a href="/" class="back-link">← Back to Home</a>
                </div>
            </body>
            </html>
        `;
    }
    
    /**
     * Escape HTML special characters
     */
    private escapeHtml(text: string): string {
        const map: Record<string, string> = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return text.replace(/[&<>"']/g, (m) => map[m]);
    }
}
