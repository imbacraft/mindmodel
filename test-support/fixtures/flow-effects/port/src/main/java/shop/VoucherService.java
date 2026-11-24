package shop;

import org.springframework.stereotype.Service;

@Service
public class VoucherService extends AbstractVersionService<Voucher> {
    private final ContractPort contractPort;

    public VoucherService(GenericRepo<Voucher> repo, ContractPort contractPort) {
        super(repo);
        this.contractPort = contractPort;
    }

    @Override
    public void publish(Long id) {
        super.publish(id);
        contractPort.publish(id);
    }
}
