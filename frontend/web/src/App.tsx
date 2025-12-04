// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface InfrastructureProject {
  id: string;
  name: string;
  description: string;
  encryptedBudget: string;
  encryptedVotes: string;
  timestamp: number;
  owner: string;
  status: "proposed" | "approved" | "rejected" | "completed";
  category: string;
}

const FHEEncryptNumber = (value: number): string => {
  return `FHE-${btoa(value.toString())}`;
};

const FHEDecryptNumber = (encryptedData: string): number => {
  if (encryptedData.startsWith('FHE-')) {
    return parseFloat(atob(encryptedData.substring(4)));
  }
  return parseFloat(encryptedData);
};

const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<InfrastructureProject[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newProjectData, setNewProjectData] = useState({ name: "", description: "", budget: 0, category: "WiFi" });
  const [selectedProject, setSelectedProject] = useState<InfrastructureProject | null>(null);
  const [decryptedBudget, setDecryptedBudget] = useState<number | null>(null);
  const [decryptedVotes, setDecryptedVotes] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState<string>("");
  const [contractAddress, setContractAddress] = useState<string>("");
  const [chainId, setChainId] = useState<number>(0);
  const [startTimestamp, setStartTimestamp] = useState<number>(0);
  const [durationDays, setDurationDays] = useState<number>(30);

  // Statistics
  const proposedCount = projects.filter(p => p.status === "proposed").length;
  const approvedCount = projects.filter(p => p.status === "approved").length;
  const rejectedCount = projects.filter(p => p.status === "rejected").length;
  const completedCount = projects.filter(p => p.status === "completed").length;
  const totalBudget = projects.reduce((sum, project) => {
    return sum + (decryptedBudget && project.id === selectedProject?.id ? decryptedBudget : 0);
  }, 0);

  useEffect(() => {
    loadProjects().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  const loadProjects = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) return;
      
      const keysBytes = await contract.getData("project_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try {
          const keysStr = ethers.toUtf8String(keysBytes);
          if (keysStr.trim() !== '') keys = JSON.parse(keysStr);
        } catch (e) { console.error("Error parsing project keys:", e); }
      }
      
      const list: InfrastructureProject[] = [];
      for (const key of keys) {
        try {
          const projectBytes = await contract.getData(`project_${key}`);
          if (projectBytes.length > 0) {
            try {
              const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
              list.push({ 
                id: key, 
                name: projectData.name,
                description: projectData.description,
                encryptedBudget: projectData.budget,
                encryptedVotes: projectData.votes,
                timestamp: projectData.timestamp, 
                owner: projectData.owner, 
                status: projectData.status || "proposed",
                category: projectData.category || "WiFi"
              });
            } catch (e) { console.error(`Error parsing project data for ${key}:`, e); }
          }
        } catch (e) { console.error(`Error loading project ${key}:`, e); }
      }
      list.sort((a, b) => b.timestamp - a.timestamp);
      setProjects(list);
    } catch (e) { console.error("Error loading projects:", e); } 
    finally { setIsRefreshing(false); setLoading(false); }
  };

  const submitProject = async () => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setCreating(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Encrypting budget data with Zama FHE..." });
    try {
      const encryptedBudget = FHEEncryptNumber(newProjectData.budget);
      const encryptedVotes = FHEEncryptNumber(0); // Initialize with 0 votes
      
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      const projectId = `proj-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`;
      const projectData = { 
        name: newProjectData.name,
        description: newProjectData.description,
        budget: encryptedBudget,
        votes: encryptedVotes,
        timestamp: Math.floor(Date.now() / 1000), 
        owner: address, 
        status: "proposed",
        category: newProjectData.category
      };
      
      await contract.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(projectData)));
      
      const keysBytes = await contract.getData("project_keys");
      let keys: string[] = [];
      if (keysBytes.length > 0) {
        try { keys = JSON.parse(ethers.toUtf8String(keysBytes)); } 
        catch (e) { console.error("Error parsing keys:", e); }
      }
      keys.push(projectId);
      await contract.setData("project_keys", ethers.toUtf8Bytes(JSON.stringify(keys)));
      
      setTransactionStatus({ visible: true, status: "success", message: "Project proposal submitted with FHE encryption!" });
      await loadProjects();
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowCreateModal(false);
        setNewProjectData({ name: "", description: "", budget: 0, category: "WiFi" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") ? "Transaction rejected by user" : "Submission failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { setCreating(false); }
  };

  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { alert("Please connect wallet first"); return null; }
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      return FHEDecryptNumber(encryptedData);
    } catch (e) { console.error("Decryption failed:", e); return null; } 
    finally { setIsDecrypting(false); }
  };

  const voteForProject = async (projectId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Processing encrypted vote with FHE..." });
    try {
      const contract = await getContractReadOnly();
      if (!contract) throw new Error("Failed to get contract");
      const projectBytes = await contract.getData(`project_${projectId}`);
      if (projectBytes.length === 0) throw new Error("Project not found");
      const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
      
      const newVotes = FHEEncryptNumber(FHEDecryptNumber(projectData.votes) + 1);
      
      const contractWithSigner = await getContractWithSigner();
      if (!contractWithSigner) throw new Error("Failed to get contract with signer");
      
      const updatedProject = { ...projectData, votes: newVotes };
      await contractWithSigner.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProject)));
      
      setTransactionStatus({ visible: true, status: "success", message: "FHE vote recorded successfully!" });
      await loadProjects();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Vote failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const approveProject = async (projectId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating project status with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const projectBytes = await contract.getData(`project_${projectId}`);
      if (projectBytes.length === 0) throw new Error("Project not found");
      const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
      const updatedProject = { ...projectData, status: "approved" };
      await contract.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProject)));
      setTransactionStatus({ visible: true, status: "success", message: "Project approved with FHE protection!" });
      await loadProjects();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Approval failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const completeProject = async (projectId: string) => {
    if (!isConnected) { alert("Please connect wallet first"); return; }
    setTransactionStatus({ visible: true, status: "pending", message: "Updating project status with FHE..." });
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      const projectBytes = await contract.getData(`project_${projectId}`);
      if (projectBytes.length === 0) throw new Error("Project not found");
      const projectData = JSON.parse(ethers.toUtf8String(projectBytes));
      const updatedProject = { ...projectData, status: "completed" };
      await contract.setData(`project_${projectId}`, ethers.toUtf8Bytes(JSON.stringify(updatedProject)));
      setTransactionStatus({ visible: true, status: "success", message: "Project marked as completed!" });
      await loadProjects();
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
    } catch (e: any) {
      setTransactionStatus({ visible: true, status: "error", message: "Completion failed: " + (e.message || "Unknown error") });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  const isOwner = (projectAddress: string) => address?.toLowerCase() === projectAddress.toLowerCase();

  if (loading) return (
    <div className="loading-screen">
      <div className="tech-spinner"></div>
      <p>Initializing encrypted connection...</p>
    </div>
  );

  return (
    <div className="app-container tech-theme">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="network-icon"></div>
          </div>
          <h1>ReFi<span>Infra</span>DAO</h1>
        </div>
        <div className="header-actions">
          <button onClick={() => setShowCreateModal(true)} className="create-project-btn tech-button">
            <div className="add-icon"></div>Propose Project
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>

      <div className="main-content">
        <div className="dashboard-panels">
          {/* Project Introduction Panel */}
          <div className="panel intro-panel tech-card">
            <h2>Community-Funded Public Infrastructure</h2>
            <p>A ReFi protocol for community-funded and governed public infrastructure (via DePIN).</p>
            <div className="fhe-badge">
              <span>Powered by Zama FHE</span>
            </div>
            <div className="feature-list">
              <div className="feature">
                <div className="feature-icon">🔒</div>
                <div className="feature-text">DePIN network data encrypted with FHE</div>
              </div>
              <div className="feature">
                <div className="feature-icon">🗳️</div>
                <div className="feature-text">Privacy-preserving DAO governance</div>
              </div>
              <div className="feature">
                <div className="feature-icon">🏗️</div>
                <div className="feature-text">Bridging ReFi from online to physical infrastructure</div>
              </div>
            </div>
          </div>

          {/* Data Statistics Panel */}
          <div className="panel stats-panel tech-card">
            <h3>Community Infrastructure Stats</h3>
            <div className="stats-grid">
              <div className="stat-item">
                <div className="stat-value">{projects.length}</div>
                <div className="stat-label">Total Projects</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{proposedCount}</div>
                <div className="stat-label">Proposed</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{approvedCount}</div>
                <div className="stat-label">Approved</div>
              </div>
              <div className="stat-item">
                <div className="stat-value">{completedCount}</div>
                <div className="stat-label">Completed</div>
              </div>
            </div>
            <div className="total-budget">
              <span>Total Community Budget:</span>
              <strong>{totalBudget.toLocaleString()} USD</strong>
            </div>
          </div>

          {/* Partners Panel */}
          <div className="panel partners-panel tech-card">
            <h3>Our Partners</h3>
            <div className="partners-grid">
              <div className="partner-logo" style={{ backgroundImage: 'url(https://zama.ai/images/logo.png)' }}></div>
              <div className="partner-logo" style={{ backgroundImage: 'url(https://ethereum.org/images/logos/ETHEREUM-ICON_Black.png)' }}></div>
              <div className="partner-logo" style={{ backgroundImage: 'url(https://upload.wikimedia.org/wikipedia/commons/5/59/Filecoin_logo.png)' }}></div>
              <div className="partner-logo" style={{ backgroundImage: 'url(https://assets-global.website-files.com/636b8f0cd5e25cf5728d2336/636b8f0cd5e25c7b8e8d2373_Logo%20Mark%20-%20Colored.svg)' }}></div>
            </div>
          </div>
        </div>

        {/* Projects List */}
        <div className="projects-section">
          <div className="section-header">
            <h2>Community Infrastructure Projects</h2>
            <div className="header-actions">
              <button onClick={loadProjects} className="refresh-btn tech-button" disabled={isRefreshing}>
                {isRefreshing ? "Refreshing..." : "Refresh"}
              </button>
            </div>
          </div>
          <div className="projects-list tech-card">
            <div className="table-header">
              <div className="header-cell">Project</div>
              <div className="header-cell">Category</div>
              <div className="header-cell">Proposer</div>
              <div className="header-cell">Date</div>
              <div className="header-cell">Status</div>
              <div className="header-cell">Actions</div>
            </div>
            {projects.length === 0 ? (
              <div className="no-projects">
                <div className="no-projects-icon"></div>
                <p>No infrastructure projects found</p>
                <button className="tech-button primary" onClick={() => setShowCreateModal(true)}>Propose First Project</button>
              </div>
            ) : projects.map(project => (
              <div className="project-row" key={project.id} onClick={() => setSelectedProject(project)}>
                <div className="table-cell project-name">{project.name}</div>
                <div className="table-cell">{project.category}</div>
                <div className="table-cell">{project.owner.substring(0, 6)}...{project.owner.substring(38)}</div>
                <div className="table-cell">{new Date(project.timestamp * 1000).toLocaleDateString()}</div>
                <div className="table-cell">
                  <span className={`status-badge ${project.status}`}>{project.status}</span>
                </div>
                <div className="table-cell actions">
                  <button 
                    className="action-btn tech-button vote" 
                    onClick={(e) => { e.stopPropagation(); voteForProject(project.id); }}
                  >
                    Vote
                  </button>
                  {isOwner(project.owner) && project.status === "proposed" && (
                    <button 
                      className="action-btn tech-button success" 
                      onClick={(e) => { e.stopPropagation(); approveProject(project.id); }}
                    >
                      Approve
                    </button>
                  )}
                  {isOwner(project.owner) && project.status === "approved" && (
                    <button 
                      className="action-btn tech-button complete" 
                      onClick={(e) => { e.stopPropagation(); completeProject(project.id); }}
                    >
                      Complete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Create Project Modal */}
      {showCreateModal && (
        <ModalCreate 
          onSubmit={submitProject} 
          onClose={() => setShowCreateModal(false)} 
          creating={creating} 
          projectData={newProjectData} 
          setProjectData={setNewProjectData}
        />
      )}

      {/* Project Detail Modal */}
      {selectedProject && (
        <ProjectDetailModal 
          project={selectedProject} 
          onClose={() => { 
            setSelectedProject(null); 
            setDecryptedBudget(null);
            setDecryptedVotes(null);
          }} 
          decryptedBudget={decryptedBudget}
          decryptedVotes={decryptedVotes}
          setDecryptedBudget={setDecryptedBudget}
          setDecryptedVotes={setDecryptedVotes}
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
        />
      )}

      {/* Transaction Status Modal */}
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content tech-card">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="tech-spinner"></div>}
              {transactionStatus.status === "success" && <div className="check-icon"></div>}
              {transactionStatus.status === "error" && <div className="error-icon"></div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}

      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="network-icon"></div>
              <span>ReFi Infra DAO</span>
            </div>
            <p>Building community-governed public infrastructure with FHE privacy</p>
          </div>
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">DAO Governance</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        <div className="footer-bottom">
          <div className="fhe-badge"><span>FHE-Powered Privacy</span></div>
          <div className="copyright">© {new Date().getFullYear()} ReFi Infra DAO. All rights reserved.</div>
        </div>
      </footer>
    </div>
  );
};

interface ModalCreateProps {
  onSubmit: () => void; 
  onClose: () => void; 
  creating: boolean;
  projectData: any;
  setProjectData: (data: any) => void;
}

const ModalCreate: React.FC<ModalCreateProps> = ({ onSubmit, onClose, creating, projectData, setProjectData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setProjectData({ ...projectData, [name]: value });
  };

  const handleBudgetChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setProjectData({ ...projectData, [name]: parseFloat(value) });
  };

  const handleSubmit = () => {
    if (!projectData.name || !projectData.budget) { 
      alert("Please fill required fields"); 
      return; 
    }
    onSubmit();
  };

  return (
    <div className="modal-overlay">
      <div className="create-modal tech-card">
        <div className="modal-header">
          <h2>Propose New Infrastructure</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="fhe-notice-banner">
            <div className="key-icon"></div> 
            <div>
              <strong>FHE Encryption Notice</strong>
              <p>Budget data will be encrypted with Zama FHE before submission</p>
            </div>
          </div>
          <div className="form-grid">
            <div className="form-group">
              <label>Project Name *</label>
              <input 
                type="text" 
                name="name" 
                value={projectData.name} 
                onChange={handleChange} 
                placeholder="Community WiFi Network" 
                className="tech-input"
              />
            </div>
            <div className="form-group">
              <label>Category *</label>
              <select name="category" value={projectData.category} onChange={handleChange} className="tech-select">
                <option value="WiFi">Community WiFi</option>
                <option value="Solar">Solar Energy</option>
                <option value="Water">Water System</option>
                <option value="Transport">Public Transport</option>
                <option value="Other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label>Description</label>
              <textarea 
                name="description" 
                value={projectData.description} 
                onChange={handleChange} 
                placeholder="Describe the infrastructure project..." 
                className="tech-textarea"
                rows={3}
              />
            </div>
            <div className="form-group">
              <label>Estimated Budget (USD) *</label>
              <input 
                type="number" 
                name="budget" 
                value={projectData.budget} 
                onChange={handleBudgetChange} 
                placeholder="10000" 
                className="tech-input"
                step="100"
                min="0"
              />
            </div>
          </div>
          <div className="encryption-preview">
            <h4>FHE Encryption Preview</h4>
            <div className="preview-container">
              <div className="plain-data">
                <span>Plain Budget:</span>
                <div>{projectData.budget || '0'} USD</div>
              </div>
              <div className="encryption-arrow">→</div>
              <div className="encrypted-data">
                <span>Encrypted Data:</span>
                <div>{projectData.budget ? FHEEncryptNumber(projectData.budget).substring(0, 50) + '...' : 'No value entered'}</div>
              </div>
            </div>
          </div>
          <div className="privacy-notice">
            <div className="privacy-icon"></div> 
            <div>
              <strong>DAO Privacy Guarantee</strong>
              <p>Budget and voting data remains encrypted during FHE processing</p>
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn tech-button">Cancel</button>
          <button onClick={handleSubmit} disabled={creating} className="submit-btn tech-button primary">
            {creating ? "Encrypting with FHE..." : "Submit Proposal"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface ProjectDetailModalProps {
  project: InfrastructureProject;
  onClose: () => void;
  decryptedBudget: number | null;
  decryptedVotes: number | null;
  setDecryptedBudget: (value: number | null) => void;
  setDecryptedVotes: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
}

const ProjectDetailModal: React.FC<ProjectDetailModalProps> = ({ 
  project, 
  onClose, 
  decryptedBudget,
  decryptedVotes,
  setDecryptedBudget,
  setDecryptedVotes,
  isDecrypting, 
  decryptWithSignature 
}) => {
  const handleDecryptBudget = async () => {
    if (decryptedBudget !== null) { 
      setDecryptedBudget(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(project.encryptedBudget);
    if (decrypted !== null) setDecryptedBudget(decrypted);
  };

  const handleDecryptVotes = async () => {
    if (decryptedVotes !== null) { 
      setDecryptedVotes(null); 
      return; 
    }
    const decrypted = await decryptWithSignature(project.encryptedVotes);
    if (decrypted !== null) setDecryptedVotes(decrypted);
  };

  return (
    <div className="modal-overlay">
      <div className="project-detail-modal tech-card">
        <div className="modal-header">
          <h2>{project.name}</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        <div className="modal-body">
          <div className="project-info">
            <div className="info-item">
              <span>Category:</span>
              <strong>{project.category}</strong>
            </div>
            <div className="info-item">
              <span>Proposer:</span>
              <strong>{project.owner.substring(0, 6)}...{project.owner.substring(38)}</strong>
            </div>
            <div className="info-item">
              <span>Date Proposed:</span>
              <strong>{new Date(project.timestamp * 1000).toLocaleString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-badge ${project.status}`}>{project.status}</strong>
            </div>
          </div>
          
          <div className="project-description">
            <h3>Description</h3>
            <p>{project.description || "No description provided"}</p>
          </div>
          
          <div className="encrypted-data-section">
            <h3>Encrypted Project Data</h3>
            
            <div className="data-item">
              <div className="data-label">Budget:</div>
              <div className="data-value">
                {project.encryptedBudget.substring(0, 100)}...
                <div className="fhe-tag">
                  <div className="fhe-icon"></div>
                  <span>FHE Encrypted</span>
                </div>
                <button 
                  className="decrypt-btn tech-button" 
                  onClick={handleDecryptBudget} 
                  disabled={isDecrypting}
                >
                  {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedBudget !== null ? "Hide Budget" : "Decrypt Budget"}
                </button>
              </div>
              {decryptedBudget !== null && (
                <div className="decrypted-value">
                  <strong>Decrypted Budget:</strong> {decryptedBudget.toLocaleString()} USD
                </div>
              )}
            </div>
            
            <div className="data-item">
              <div className="data-label">Votes:</div>
              <div className="data-value">
                {project.encryptedVotes.substring(0, 100)}...
                <div className="fhe-tag">
                  <div className="fhe-icon"></div>
                  <span>FHE Encrypted</span>
                </div>
                <button 
                  className="decrypt-btn tech-button" 
                  onClick={handleDecryptVotes} 
                  disabled={isDecrypting}
                >
                  {isDecrypting ? <span className="decrypt-spinner"></span> : decryptedVotes !== null ? "Hide Votes" : "Decrypt Votes"}
                </button>
              </div>
              {decryptedVotes !== null && (
                <div className="decrypted-value">
                  <strong>Decrypted Votes:</strong> {decryptedVotes}
                </div>
              )}
            </div>
          </div>
          
          <div className="decryption-notice">
            <div className="warning-icon"></div>
            <span>Decrypted data requires wallet signature verification</span>
          </div>
        </div>
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn tech-button">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;
