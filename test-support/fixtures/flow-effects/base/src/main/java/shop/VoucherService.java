package shop;

import org.springframework.stereotype.Service;

@Service
public class VoucherService extends AbstractVersionService<Voucher> {
    public VoucherService(GenericRepo<Voucher> repo) {
        super(repo);
    }

    @Override
    public void publish(Long id) {
        super.publish(id);
    }
}
